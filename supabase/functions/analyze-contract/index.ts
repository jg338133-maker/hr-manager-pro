const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type ContractResult = {
  name: string | null;
  last: string | null;
  email: string | null;
  phone: string | null;
  startDate: string | null;
  endDate: string | null;
  contract: "Indefinido" | "Temporal" | "Aprendizaje" | "Practicante" | "Otro" | null;
  position: string | null;
  department: string | null;
  payType: "hourly" | "monthly" | null;
  rate: number | null;
  workPercent: number | null;
  weeklyHours: number | null;
  vacWeeks: number | null;
  avs: string | null;
  emergency: string | null;
  notes: string | null;
  confidence: Record<string, "high" | "medium" | "low">;
  warnings: string[];
};

const emptyResult = (): ContractResult => ({
  name: null,
  last: null,
  email: null,
  phone: null,
  startDate: null,
  endDate: null,
  contract: null,
  position: null,
  department: null,
  payType: null,
  rate: null,
  workPercent: null,
  weeklyHours: null,
  vacWeeks: null,
  avs: null,
  emergency: null,
  notes: null,
  confidence: {},
  warnings: [],
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function extractJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const raw = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  return JSON.parse(raw);
}

function normalizeResult(input: Record<string, unknown>): ContractResult {
  const out = emptyResult();
  const keys = Object.keys(out) as Array<keyof ContractResult>;
  for (const key of keys) {
    if (key === "confidence" || key === "warnings") continue;
    if (input[key] !== undefined) (out as Record<string, unknown>)[key] = input[key] ?? null;
  }
  out.confidence = typeof input.confidence === "object" && input.confidence
    ? input.confidence as ContractResult["confidence"]
    : {};
  out.warnings = Array.isArray(input.warnings) ? input.warnings.map(String) : [];
  return out;
}

async function callOpenAICompatible(apiKey: string, model: string, system: string, user: string) {
  const baseUrl = (Deno.env.get("AI_BASE_URL") || "https://api.openai.com/v1").replace(/\/$/, "");
  const aiRes = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!aiRes.ok) {
    const detail = await aiRes.text();
    throw new Error(`AI request failed: ${detail}`);
  }

  const payload = await aiRes.json();
  return payload?.choices?.[0]?.message?.content || "{}";
}

async function callAnthropic(apiKey: string, model: string, system: string, user: string) {
  const baseUrl = (Deno.env.get("AI_BASE_URL") || "https://api.anthropic.com/v1").replace(/\/$/, "");
  const aiRes = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": Deno.env.get("ANTHROPIC_VERSION") || "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      temperature: 0.1,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!aiRes.ok) {
    const detail = await aiRes.text();
    throw new Error(`Anthropic request failed: ${detail}`);
  }

  const payload = await aiRes.json();
  return (payload?.content || [])
    .filter((part: { type?: string; text?: string }) => part.type === "text")
    .map((part: { text?: string }) => part.text || "")
    .join("\n") || "{}";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const apiKey = Deno.env.get("AI_API_KEY") || Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) return jsonResponse({ error: "Missing AI_API_KEY secret" }, 500);

    const provider = (Deno.env.get("AI_PROVIDER") || (apiKey.startsWith("sk-ant-") ? "anthropic" : "openai")).toLowerCase();
    const model = Deno.env.get("AI_MODEL") || Deno.env.get("OPENAI_MODEL") || (provider === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o-mini");
    const { text = "", fileName = "contract" } = await req.json();
    const contractText = String(text || "").slice(0, 18000);
    if (!contractText.trim()) return jsonResponse({ error: "Contract text is required" }, 400);

    const system = [
      "You extract structured employee profile data from employment contracts.",
      "The contract may be in Spanish, French, Italian, German, or English.",
      "Return only valid JSON. No markdown. No explanation.",
      "If a field is not present, use null.",
      "Dates must be YYYY-MM-DD.",
      "contract must be one of: Indefinido, Temporal, Aprendizaje, Practicante, Otro.",
      "payType must be hourly, monthly, or null.",
      "rate must be hourly salary when payType is hourly, or monthly salary when payType is monthly.",
      "workPercent, weeklyHours, vacWeeks, and rate must be numbers when present.",
      "confidence values must be high, medium, or low.",
    ].join(" ");

    const user = `Analyze this employment contract named ${fileName}.

Return this exact JSON shape:
{
  "name": null,
  "last": null,
  "email": null,
  "phone": null,
  "startDate": null,
  "endDate": null,
  "contract": null,
  "position": null,
  "department": null,
  "payType": null,
  "rate": null,
  "workPercent": null,
  "weeklyHours": null,
  "vacWeeks": null,
  "avs": null,
  "emergency": null,
  "notes": null,
  "confidence": {},
  "warnings": []
}

CONTRACT:
${contractText}`;

    const content = provider === "anthropic"
      ? await callAnthropic(apiKey, model, system, user)
      : await callOpenAICompatible(apiKey, model, system, user);
    return jsonResponse(normalizeResult(extractJson(content)));
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
