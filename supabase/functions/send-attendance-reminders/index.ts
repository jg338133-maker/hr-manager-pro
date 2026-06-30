import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type EmployeeRow = {
  id: string;
  restaurant_id: string;
  name: string | null;
  last_name: string | null;
  email: string | null;
  status: string | null;
  phone: string | null;
  schedules: Record<string, DaySchedule> | null;
  whatsapp_phone: string | null;
  whatsapp_reminders_enabled: boolean | null;
  reminder_before_minutes: number | null;
  reminder_after_minutes: number | null;
};

type RestaurantRow = {
  id: string;
  name: string | null;
  lang: string | null;
};

type ShiftRow = {
  restaurant_id: string;
  employee_id: string;
  shift_date: string;
  shift_type: string | null;
  start_time: string | null;
  end_time: string | null;
  blocks: TimeBlock[] | null;
  notes: string | null;
};

type AttendanceRow = {
  employee_id: string;
  type: string;
  timestamp: string;
};

type WorkSegment = {
  start: Date;
  end: Date | null;
  breakMinutes: number;
};

type BreakSegment = {
  start: Date;
  end: Date | null;
  minutes: number;
};

type AttendanceSummary = {
  segments: WorkSegment[];
  breaks: BreakSegment[];
  totalMinutes: number;
};

type DaySchedule = {
  enabled?: boolean;
  blocks?: TimeBlock[];
  start?: string;
  end?: string;
};

type TimeBlock = {
  start?: string;
  end?: string;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
const TWILIO_WHATSAPP_FROM = Deno.env.get("TWILIO_WHATSAPP_FROM") || "";
const CRON_SECRET = Deno.env.get("REMINDER_CRON_SECRET") || "";
const APP_BASE_URL = Deno.env.get("APP_BASE_URL") || "https://manager-pro.app/";
const TZ = Deno.env.get("REMINDER_TIMEZONE") || "Europe/Zurich";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function cleanPhone(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/[^\d+]/g, "");
  return normalized.startsWith("+") ? normalized : `+${normalized}`;
}

function dateKeyInTz(date: Date, timeZone = TZ) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function addDays(dateKey: string, days: number) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return dateKeyInTz(dt, "UTC");
}

function offsetMinutesFor(date: Date, timeZone = TZ) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value || "0");
  const asUtc = Date.UTC(pick("year"), pick("month") - 1, pick("day"), pick("hour"), pick("minute"), pick("second"));
  return (asUtc - date.getTime()) / 60000;
}

function localTimeToInstant(dateKey: string, timeValue: string, timeZone = TZ) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const [hh, mm] = timeValue.split(":").map(Number);
  const utcGuess = new Date(Date.UTC(y, m - 1, d, hh || 0, mm || 0, 0));
  const offset = offsetMinutesFor(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offset * 60000);
}

function minutesBetween(a: Date, b: Date) {
  return (a.getTime() - b.getTime()) / 60000;
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60000);
}

function timeLabel(date: Date, timeZone = TZ) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function dateLabel(dateKey: string, lang: string, timeZone = TZ) {
  const date = localTimeToInstant(dateKey, "12:00", timeZone);
  return new Intl.DateTimeFormat(lang || "es", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function formatDuration(minutes: number, lang = "es") {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  if (!hours) return `${mins} min`;
  if (!mins) return `${hours}h`;
  return lang === "en" ? `${hours}h ${mins}m` : `${hours}h ${mins}min`;
}

function overlapMinutes(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  const start = Math.max(aStart.getTime(), bStart.getTime());
  const end = Math.min(aEnd.getTime(), bEnd.getTime());
  return Math.max(0, (end - start) / 60000);
}

function normalizeBlocks(day?: DaySchedule | null): TimeBlock[] {
  const blocks = Array.isArray(day?.blocks) ? day!.blocks! : [];
  const normalized = blocks
    .map((b) => ({ start: String(b?.start || "").slice(0, 5), end: String(b?.end || "").slice(0, 5) }))
    .filter((b) => /^\d{2}:\d{2}$/.test(b.start) && /^\d{2}:\d{2}$/.test(b.end));
  if (normalized.length) return normalized;
  if (day?.start && day?.end) return [{ start: String(day.start).slice(0, 5), end: String(day.end).slice(0, 5) }];
  return [];
}

function blocksFromShift(shift?: ShiftRow) {
  if (!shift) return null;
  const type = String(shift.shift_type || "").toLowerCase();
  if (["off", "rest", "closed", "abs"].includes(type)) return [];
  return normalizeBlocks({ blocks: shift.blocks || [], start: shift.start_time || "", end: shift.end_time || "" });
}

function plannedBlocks(emp: EmployeeRow, dateKey: string, shifts: ShiftRow[]) {
  const manualShift = shifts.find((s) => s.employee_id === emp.id && s.shift_date === dateKey && s.notes !== "Horaire de base");
  const manualBlocks = blocksFromShift(manualShift);
  if (manualBlocks) return manualBlocks;

  const dayIndex = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  const schedule = emp.schedules?.[String(dayIndex)];
  if (!schedule?.enabled) return [];
  return normalizeBlocks(schedule);
}

function hasClockIn(empId: string, start: Date, now: Date, attendance: AttendanceRow[]) {
  const dayStart = new Date(start);
  dayStart.setUTCHours(0, 0, 0, 0);
  return attendance.some((row) => {
    if (row.employee_id !== empId || row.type !== "in") return false;
    const ts = new Date(row.timestamp);
    return ts >= dayStart && ts <= now;
  });
}

function attendanceForDay(empId: string, dateKey: string, attendance: AttendanceRow[]) {
  const dayStart = localTimeToInstant(dateKey, "00:00");
  const dayEnd = localTimeToInstant(addDays(dateKey, 1), "00:00");
  return attendance
    .filter((row) => row.employee_id === empId)
    .map((row) => ({ ...row, date: new Date(row.timestamp) }))
    .filter((row) => row.date >= dayStart && row.date < dayEnd)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

function buildAttendanceSummary(empId: string, dateKey: string, attendance: AttendanceRow[]): AttendanceSummary | null {
  const rows = attendanceForDay(empId, dateKey, attendance);
  const segments: WorkSegment[] = [];
  const breaks: BreakSegment[] = [];
  let activeIn: Date | null = null;
  let activeBreak: Date | null = null;

  for (const row of rows) {
    if (row.type === "in") {
      activeIn = row.date;
    } else if (row.type === "out" && activeIn) {
      if (row.date > activeIn) segments.push({ start: activeIn, end: row.date, breakMinutes: 0 });
      activeIn = null;
    } else if (row.type === "break_start") {
      activeBreak = row.date;
    } else if (row.type === "break_end" && activeBreak) {
      const minutes = row.date > activeBreak ? (row.date.getTime() - activeBreak.getTime()) / 60000 : 0;
      breaks.push({ start: activeBreak, end: row.date, minutes });
      activeBreak = null;
    }
  }

  if (activeIn) segments.push({ start: activeIn, end: null, breakMinutes: 0 });
  if (activeBreak) breaks.push({ start: activeBreak, end: null, minutes: 0 });

  let totalMinutes = 0;
  for (const segment of segments) {
    if (!segment.end) continue;
    const rawMinutes = (segment.end.getTime() - segment.start.getTime()) / 60000;
    const breakMinutes = breaks.reduce((sum, brk) => {
      if (!brk.end) return sum;
      return sum + overlapMinutes(segment.start, segment.end!, brk.start, brk.end);
    }, 0);
    segment.breakMinutes = breakMinutes;
    totalMinutes += Math.max(0, rawMinutes - breakMinutes);
  }

  if (!segments.length || totalMinutes <= 0) return null;
  return { segments, breaks, totalMinutes };
}

function latestBlockEnd(dateKey: string, blocks: TimeBlock[]) {
  const ends = blocks
    .filter((block) => block.start && block.end)
    .map((block) => {
      const start = localTimeToInstant(dateKey, block.start!);
      let end = localTimeToInstant(dateKey, block.end!);
      if (end <= start) end = addMinutes(end, 24 * 60);
      return end;
    })
    .sort((a, b) => b.getTime() - a.getTime());
  return ends[0] || null;
}

function employeeName(emp: EmployeeRow) {
  return [emp.name, emp.last_name].filter(Boolean).join(" ").trim() || "Equipo";
}

function employeePortalUrl(emp: EmployeeRow) {
  const url = new URL(APP_BASE_URL);
  url.searchParams.set("employee", emp.id);
  if (emp.email) url.searchParams.set("email", emp.email);
  return url.toString();
}

function messageFor(type: "before_start" | "late_employee", emp: EmployeeRow, restaurant: RestaurantRow | undefined, startTime: string) {
  const lang = String(restaurant?.lang || "es").slice(0, 2);
  const name = employeeName(emp);
  const business = restaurant?.name || "tu negocio";
  const url = employeePortalUrl(emp);
  const messages: Record<string, Record<string, string>> = {
    before_start: {
      es: `Hola ${name}, recuerda marcar tu entrada en Manager Pro. Tu turno en ${business} empieza a las ${startTime}.\n\nAbrir portal:\n${url}`,
      fr: `Bonjour ${name}, pense a pointer ton entree dans Manager Pro. Ton service chez ${business} commence a ${startTime}.\n\nOuvrir le portail:\n${url}`,
      it: `Ciao ${name}, ricordati di timbrare l'entrata in Manager Pro. Il tuo turno da ${business} inizia alle ${startTime}.\n\nApri il portale:\n${url}`,
      de: `Hallo ${name}, bitte denke daran, deinen Arbeitsbeginn in Manager Pro zu erfassen. Deine Schicht bei ${business} startet um ${startTime}.\n\nPortal offnen:\n${url}`,
      en: `Hi ${name}, remember to clock in on Manager Pro. Your shift at ${business} starts at ${startTime}.\n\nOpen portal:\n${url}`,
    },
    late_employee: {
      es: `Hola ${name}, tu turno en ${business} empezo a las ${startTime} y aun no vemos tu entrada. Abre tu portal, escribe tu PIN y marca entrada. Si hay un problema, avisa al manager.\n\nAbrir portal:\n${url}`,
      fr: `Bonjour ${name}, ton service chez ${business} a commence a ${startTime} et ton entree n'apparait pas encore. Ouvre ton portail, saisis ton PIN et pointe. Si besoin, previens le manager.\n\nOuvrir le portail:\n${url}`,
      it: `Ciao ${name}, il tuo turno da ${business} e iniziato alle ${startTime} e non vediamo ancora l'entrata. Apri il tuo portale, inserisci il PIN e timbra. Se c'e un problema, avvisa il manager.\n\nApri il portale:\n${url}`,
      de: `Hallo ${name}, deine Schicht bei ${business} hat um ${startTime} begonnen und dein Arbeitsbeginn ist noch nicht erfasst. Offne dein Portal, gib deine PIN ein und erfasse den Start. Bei Problemen informiere den Manager.\n\nPortal offnen:\n${url}`,
      en: `Hi ${name}, your shift at ${business} started at ${startTime}, but we do not see your clock-in yet. Open your portal, enter your PIN, and clock in. If there is an issue, tell your manager.\n\nOpen portal:\n${url}`,
    },
  };
  return messages[type][lang] || messages[type].es;
}

function summaryMessageFor(emp: EmployeeRow, restaurant: RestaurantRow | undefined, dateKey: string, summary: AttendanceSummary) {
  const lang = String(restaurant?.lang || "es").slice(0, 2);
  const name = employeeName(emp);
  const business = restaurant?.name || "Manager Pro";
  const url = employeePortalUrl(emp);
  const day = dateLabel(dateKey, lang);
  const labels: Record<string, Record<string, string>> = {
    title: { es: "Resumen de tu jornada", fr: "Resume de ta journee", it: "Riepilogo della tua giornata", de: "Zusammenfassung deines Arbeitstags", en: "Your workday summary" },
    hello: { es: "Hola", fr: "Bonjour", it: "Ciao", de: "Hallo", en: "Hi" },
    block: { es: "Bloque", fr: "Bloc", it: "Blocco", de: "Block", en: "Block" },
    entry: { es: "Entrada", fr: "Entree", it: "Entrata", de: "Start", en: "Clock in" },
    exit: { es: "Salida", fr: "Sortie", it: "Uscita", de: "Ende", en: "Clock out" },
    breaks: { es: "Pausas", fr: "Pauses", it: "Pause", de: "Pausen", en: "Breaks" },
    noBreaks: { es: "Sin pausas registradas", fr: "Aucune pause enregistree", it: "Nessuna pausa registrata", de: "Keine Pause erfasst", en: "No breaks recorded" },
    open: { es: "sin cierre", fr: "sans fermeture", it: "senza chiusura", de: "offen", en: "open" },
    total: { es: "Tiempo trabajado", fr: "Temps travaille", it: "Tempo lavorato", de: "Arbeitszeit", en: "Worked time" },
    portal: { es: "Abrir portal", fr: "Ouvrir le portail", it: "Apri il portale", de: "Portal offnen", en: "Open portal" },
  };
  const t = (key: string) => labels[key]?.[lang] || labels[key]?.es || key;
  const lines = [`${t("title")} - ${business}`, `${t("hello")} ${name}, ${day}`];

  summary.segments.forEach((segment, index) => {
    const worked = segment.end ? formatDuration((segment.end.getTime() - segment.start.getTime()) / 60000 - segment.breakMinutes, lang) : t("open");
    lines.push(`${t("block")} ${index + 1}: ${timeLabel(segment.start)} - ${segment.end ? timeLabel(segment.end) : t("open")} (${worked})`);
  });

  if (summary.breaks.length) {
    lines.push(`${t("breaks")}:`);
    for (const brk of summary.breaks) {
      lines.push(`- ${timeLabel(brk.start)} - ${brk.end ? timeLabel(brk.end) : t("open")} (${brk.end ? formatDuration(brk.minutes, lang) : t("open")})`);
    }
  } else {
    lines.push(`${t("breaks")}: ${t("noBreaks")}`);
  }

  lines.push(`${t("total")}: ${formatDuration(summary.totalMinutes, lang)}`);
  lines.push(`${t("portal")}:\n${url}`);
  return lines.join("\n");
}

async function sendWhatsApp(to: string, body: string) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
    throw new Error("Missing Twilio WhatsApp secrets");
  }
  const params = new URLSearchParams();
  params.set("From", TWILIO_WHATSAPP_FROM);
  params.set("To", `whatsapp:${to}`);
  params.set("Body", body);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.message || `Twilio error ${res.status}`);
  return json?.sid || "";
}

async function createLog(payload: Record<string, unknown>) {
  const { data, error } = await supabase.from("attendance_reminder_logs").insert(payload).select("id").single();
  if (error) {
    if (String(error.message || "").toLowerCase().includes("duplicate")) return null;
    throw error;
  }
  return data?.id as string;
}

Deno.serve(async (req) => {
  try {
    if (CRON_SECRET && req.headers.get("x-cron-secret") !== CRON_SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
    const now = new Date();
    const today = dateKeyInTz(now);
    const dates = [addDays(today, -1), today, addDays(today, 1)];
    const minIso = localTimeToInstant(dates[0], "00:00").toISOString();
    const maxIso = localTimeToInstant(dates[2], "23:59").toISOString();

    const { data: employees, error: empError } = await supabase
      .from("employees")
      .select("id,restaurant_id,name,last_name,email,status,phone,schedules,whatsapp_phone,whatsapp_reminders_enabled,reminder_before_minutes,reminder_after_minutes")
      .eq("status", "active")
      .eq("whatsapp_reminders_enabled", true);
    if (empError) throw empError;

    const activeEmployees = (employees || []) as EmployeeRow[];
    const restaurantIds = [...new Set(activeEmployees.map((e) => e.restaurant_id).filter(Boolean))];
    if (!restaurantIds.length) return new Response(JSON.stringify({ ok: true, scanned: 0, sent: 0 }), { headers: { "Content-Type": "application/json" } });

    const [{ data: restaurants }, { data: shifts }, { data: attendance }] = await Promise.all([
      supabase.from("restaurants").select("id,name,lang").in("id", restaurantIds),
      supabase.from("shifts").select("restaurant_id,employee_id,shift_date,shift_type,start_time,end_time,blocks,notes").in("restaurant_id", restaurantIds).in("shift_date", dates),
      supabase.from("attendance").select("employee_id,type,timestamp").in("restaurant_id", restaurantIds).gte("timestamp", minIso).lte("timestamp", maxIso),
    ]);

    const restaurantById = new Map((restaurants || []).map((r: RestaurantRow) => [r.id, r]));
    const shiftRows = (shifts || []) as ShiftRow[];
    const attendanceRows = (attendance || []) as AttendanceRow[];
    let scanned = 0;
    let sent = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const emp of activeEmployees) {
      const phone = cleanPhone(emp.whatsapp_phone || emp.phone);
      if (!phone) {
        skipped++;
        continue;
      }
      for (const dateKey of dates) {
        const blocks = plannedBlocks(emp, dateKey, shiftRows);
        const finalEnd = latestBlockEnd(dateKey, blocks);
        const summaryAfterMin = 1;
        const summaryDue = finalEnd ? addMinutes(finalEnd, summaryAfterMin) : null;
        const summaryLag = summaryDue ? minutesBetween(now, summaryDue) : -1;

        if (finalEnd && summaryLag >= 0 && summaryLag <= 180) {
          const summary = buildAttendanceSummary(emp.id, dateKey, attendanceRows);
          if (summary) {
            const logId = await createLog({
              restaurant_id: emp.restaurant_id,
              employee_id: emp.id,
              shift_date: dateKey,
              shift_start: finalEnd.toISOString(),
              reminder_type: "daily_summary",
              channel: "whatsapp",
              recipient: phone,
              status: "pending",
              provider: "twilio",
            });
            if (!logId) {
              skipped++;
            } else {
              try {
                const sid = await sendWhatsApp(phone, summaryMessageFor(emp, restaurantById.get(emp.restaurant_id), dateKey, summary));
                await supabase.from("attendance_reminder_logs").update({ status: "sent", provider_message_id: sid, sent_at: new Date().toISOString() }).eq("id", logId);
                sent++;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                await supabase.from("attendance_reminder_logs").update({ status: "error", error: message }).eq("id", logId);
                errors.push(message);
              }
            }
          }
        }

        for (const block of blocks) {
          if (!block.start) continue;
          scanned++;
          const start = localTimeToInstant(dateKey, block.start);
          const beforeMin = Math.max(0, Number(emp.reminder_before_minutes || 5));
          const afterMin = Math.max(1, Number(emp.reminder_after_minutes || 10));
          const dueBefore = new Date(start.getTime() - beforeMin * 60000);
          const dueLate = new Date(start.getTime() + afterMin * 60000);
          const clockedIn = hasClockIn(emp.id, start, now, attendanceRows);
          const due: Array<"before_start" | "late_employee"> = [];
          if (!clockedIn && minutesBetween(now, dueBefore) >= 0 && minutesBetween(now, dueBefore) <= 6) due.push("before_start");
          if (!clockedIn && minutesBetween(now, dueLate) >= 0 && minutesBetween(now, dueLate) <= 6) due.push("late_employee");

          for (const reminderType of due) {
            const logId = await createLog({
              restaurant_id: emp.restaurant_id,
              employee_id: emp.id,
              shift_date: dateKey,
              shift_start: start.toISOString(),
              reminder_type: reminderType,
              channel: "whatsapp",
              recipient: phone,
              status: "pending",
              provider: "twilio",
            });
            if (!logId) {
              skipped++;
              continue;
            }
            try {
              const sid = await sendWhatsApp(phone, messageFor(reminderType, emp, restaurantById.get(emp.restaurant_id), block.start));
              await supabase.from("attendance_reminder_logs").update({ status: "sent", provider_message_id: sid, sent_at: new Date().toISOString() }).eq("id", logId);
              sent++;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              await supabase.from("attendance_reminder_logs").update({ status: "error", error: message }).eq("id", logId);
              errors.push(message);
            }
          }
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, scanned, sent, skipped, errors }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
