const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type AssistantResult = {
  answer: string;
  category: "app_help" | "daily_ops" | "reporting" | "data_quality" | "feature_request" | "other";
  shouldSaveSignal: boolean;
};

function sanitizeAnswer(text: string) {
  return String(text || "")
    .replace(/```(?:json|text)?/gi, "")
    .replace(/```/g, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1 ($2)")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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

function normalize(input: Record<string, unknown>): AssistantResult {
  const category = String(input.category || "other") as AssistantResult["category"];
  return {
    answer: sanitizeAnswer(String(input.answer || "No tengo suficiente informacion para responder eso con seguridad.")),
    category: ["app_help", "daily_ops", "reporting", "data_quality", "feature_request", "other"].includes(category) ? category : "other",
    shouldSaveSignal: Boolean(input.shouldSaveSignal),
  };
}

function shouldEnableWebSearch(question: string) {
  const flag = (Deno.env.get("AI_ENABLE_WEB_SEARCH") || "").toLowerCase();
  if (!["true", "1", "yes", "on"].includes(flag)) return false;
  return /\b(ley|legal|derecho|contrato|desped|indemniz|preaviso|aviso|norma|regla|suiza|swiss|suisse|arbeitsrecht|licenciement|licenziamento|dismiss|termination|law|legal|actual|vigente|hoy|web|internet|buscar|fuente|source)\b/i.test(question);
}

function plain(text: string) {
  return String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function detectLanguage(question: string, fallback = "es") {
  const raw = String(question || "").toLowerCase();
  const q = plain(raw);
  if (/\b(cosa|come|quali|quanto|vendite|vendita|ricavi|entrate|incassi|dipendenti|personale|manca|mancano|questo mese|inventario|fornitori|acquisti|crediti|documenti|timbrature|chiudere|chiusura)\b/.test(q)) return "it";
  if (/[¿¡ñáéíóú]/i.test(raw) || /\b(que|como|cual|cuanto|ventas|ingresos|empleados|trabajadores|faltan|falta|este mes|inventario|proveedores|compras|cartera|documentos|fichajes|cerrar mes)\b/.test(q)) return "es";
  if (/[àâçéèêëîïôùûüÿœæ]/i.test(raw) || /\b(quoi|comment|quels|combien|ventes|revenus|employes|personnel|manquent|ce mois|inventaire|fournisseurs|achats|creances|documents|pointages|cloture)\b/.test(q)) return "fr";
  if (/[äöüß]/i.test(raw) || /\b(was|wie|welche|wieviel|verkauf|umsatz|mitarbeiter|fehlen|diesen monat|inventar|lieferanten|einkaufe|forderungen|dokumente|stempel)\b/.test(q)) return "de";
  if (/\b(what|how|which|how many|sales|revenue|employees|missing|this month|inventory|suppliers|purchases|receivables|documents|clock|payroll)\b/.test(q)) return "en";
  return ["es", "fr", "en", "de", "it"].includes(fallback) ? fallback : "es";
}

function fallbackAnswer(lang: string) {
  const copy: Record<string, string> = {
    es: "No pude consultar la IA en este momento. Puedo seguir ayudando con respuestas básicas dentro de la app.",
    it: "Non ho potuto consultare l'IA in questo momento. Posso comunque aiutarti con risposte di base dentro l'app.",
    fr: "Je n'ai pas pu consulter l'IA pour le moment. Je peux quand même t'aider avec les réponses de base dans l'app.",
    en: "I could not reach the AI right now. I can still help with basic answers inside the app.",
    de: "Ich konnte die KI gerade nicht erreichen. Ich kann dir trotzdem mit grundlegenden Antworten in der App helfen.",
  };
  return copy[lang] || copy.es;
}

function webFallbackNote(lang: string) {
  const copy: Record<string, string> = {
    es: "Nota: no pude activar la búsqueda web desde Manager Pro en este intento. Para decisiones legales o contractuales, verifica la información con una fuente oficial o un asesor local.",
    it: "Nota: non ho potuto attivare la ricerca web da Manager Pro in questo tentativo. Per decisioni legali o contrattuali, verifica le informazioni con una fonte ufficiale o un consulente locale.",
    fr: "Note: je n'ai pas pu activer la recherche web depuis Manager Pro lors de cet essai. Pour les décisions légales ou contractuelles, vérifie l'information avec une source officielle ou un conseiller local.",
    en: "Note: I could not activate web search from Manager Pro on this attempt. For legal or contract decisions, verify the information with an official source or a local advisor.",
    de: "Hinweis: Ich konnte die Websuche in Manager Pro bei diesem Versuch nicht aktivieren. Prüfe rechtliche oder vertragliche Entscheidungen mit einer offiziellen Quelle oder lokaler Beratung.",
  };
  return copy[lang] || copy.es;
}

function isSensitiveHrQuestion(question: string) {
  const q = plain(question);
  return /desped|despido|termin.*contrato|contrato.*termin|finaliz.*contrato|contrato.*finaliz|rescind|desvincul|renuncia|sancion|disciplin|ausencia.*injust|abandono|conflicto|acoso|queja|incapacidad|licenciement|licenziamento|kundig|dismiss|termination|fire|harassment|disciplinary/.test(q);
}

async function callAnthropic(apiKey: string, model: string, system: string, user: string, enableWebSearch: boolean, responseLang = "es") {
  const baseUrl = (Deno.env.get("AI_BASE_URL") || "https://api.anthropic.com/v1").replace(/\/$/, "");
  const body: Record<string, unknown> = {
    model,
    max_tokens: enableWebSearch ? 1500 : 1000,
    temperature: 0.2,
    system,
    messages: [{ role: "user", content: user }],
  };
  if (enableWebSearch) {
    body.tools = [{
      type: Deno.env.get("ANTHROPIC_WEB_SEARCH_VERSION") || "web_search_20250305",
      name: "web_search",
      max_uses: Number(Deno.env.get("AI_WEB_SEARCH_MAX_USES") || 2),
      user_location: {
        type: "approximate",
        country: Deno.env.get("AI_WEB_SEARCH_COUNTRY") || "CH",
        timezone: Deno.env.get("AI_WEB_SEARCH_TIMEZONE") || "Europe/Zurich",
      },
    }];
  }
  const aiRes = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": Deno.env.get("ANTHROPIC_VERSION") || "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!aiRes.ok && enableWebSearch) {
    const fallback = await callAnthropic(apiKey, model, system, user, false, responseLang);
    return `${fallback}\n\n${webFallbackNote(responseLang)}`;
  }
  if (!aiRes.ok) throw new Error(`Anthropic request failed: ${await aiRes.text()}`);
  const payload = await aiRes.json();
  const citations: { title: string; url: string }[] = [];
  const text = (payload?.content || [])
    .filter((part: { type?: string; text?: string; citations?: { title?: string; url?: string }[] }) => part.type === "text")
    .map((part: { text?: string; citations?: { title?: string; url?: string }[] }) => {
      (part.citations || []).forEach((c) => {
        if (c?.url) citations.push({ title: c.title || c.url, url: c.url });
      });
      return part.text || "";
    })
    .join("\n") || "{}";
  const uniqueSources = citations.filter((c, i, arr) => arr.findIndex((x) => x.url === c.url) === i).slice(0, 4);
  return uniqueSources.length
    ? `${text}\n\nFuentes consultadas:\n${uniqueSources.map((c) => `- ${c.title}: ${c.url}`).join("\n")}`
    : text;
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
      temperature: 0.25,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!aiRes.ok) throw new Error(`AI request failed: ${await aiRes.text()}`);
  const payload = await aiRes.json();
  return payload?.choices?.[0]?.message?.content || "{}";
}

async function callOpenAIText(apiKey: string, model: string, system: string, user: string) {
  const baseUrl = (Deno.env.get("AI_BASE_URL") || "https://api.openai.com/v1").replace(/\/$/, "");
  const aiRes = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!aiRes.ok) throw new Error(`AI request failed: ${await aiRes.text()}`);
  const payload = await aiRes.json();
  return payload?.choices?.[0]?.message?.content || "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let responseLang = "es";
  try {
    const apiKey = Deno.env.get("AI_API_KEY") || Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) return jsonResponse({ error: "Missing AI_API_KEY secret" }, 500);

    const provider = (Deno.env.get("AI_PROVIDER") || (apiKey.startsWith("sk-ant-") ? "anthropic" : "openai")).toLowerCase();
    const model = Deno.env.get("AI_MODEL") || Deno.env.get("OPENAI_MODEL") || (provider === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o-mini");
    const { question = "", language = "", context = {}, history = [] } = await req.json();
    const q = String(question || "").trim();
    if (!q) return jsonResponse({ error: "Question is required" }, 400);
    const requestedLang = String(language || (context as Record<string, unknown>)?.lang || "es");
    responseLang = detectLanguage(q, requestedLang);

    if (isSensitiveHrQuestion(q)) {
      const directSystem = [
        "You are Manager Pro's business operations and HR assistant for small businesses.",
        `Answer in the same language as the user's latest question. Detected answer language: ${responseLang}. context.uiLang is only the interface language.`,
        "Write plain text only. No Markdown. No bold markers. No headings. No tables.",
        "Be more useful than a generic disclaimer: give practical HR guidance, conversation strategy, documentation steps, risks to verify, and what Manager Pro can record.",
        "For legal or contract termination topics, do not present yourself as a lawyer and do not invent exact legal rules. If the user mentions a country such as Switzerland, use current web information when web search is enabled, cite sources plainly, and still advise verification with a qualified local professional before acting.",
        "Structure the answer like a manager could use it today: what to check, what to say, what to document, what not to do, and when to ask for legal help.",
        "Avoid canned phrases. Adapt to the user's exact question.",
      ].join(" ");
      const directUser = `Question:
${q}

App context:
${JSON.stringify(context).slice(0, 12000)}

Recent history:
${JSON.stringify(history).slice(0, 3000)}

Answer language:
${responseLang}

Give the final answer directly.`;
      const answer = provider === "anthropic"
        ? await callAnthropic(apiKey, model, directSystem, directUser, shouldEnableWebSearch(q), responseLang)
        : await callOpenAIText(apiKey, model, directSystem, directUser);
      return jsonResponse({
        answer: sanitizeAnswer(answer),
        category: "daily_ops",
        shouldSaveSignal: false,
      });
    }

    const system = [
      "You are the manager assistant inside Manager Pro, a simple management app for small businesses.",
      `Answer in the same language as the user's latest question. Detected answer language: ${responseLang}. context.uiLang is only the interface language.`,
      "Write in plain text only. Do not use Markdown formatting. Never use bold markers, headings, tables, code fences, or markdown links. Numbered steps are allowed.",
      "Do not limit yourself to explaining the app. Help with any reasonable question a small-business manager may ask: HR, team conversations, sales, inventory, costs, operations, customer situations, planning, reports, documents, communication, and business decisions.",
      "When the question is outside the current app features, still answer helpfully. Then, if useful, add how Manager Pro can help document, track, or follow up.",
      "You are a calm operational coach for small-business managers who may need help with soft conversations, accountability, punctuality, conflict, motivation, and follow-up.",
      "For human/team questions, never say this is outside the app. Give a practical manager-ready answer: empathic framing, concrete talking points, questions to ask, a simple agreement, follow-up timing, and what to document.",
      "Keep advice humane and direct. Avoid shaming the employee. Separate facts, impact, cause, agreement, and follow-up.",
      "For dismissal, termination, formal discipline, legal, payroll, tax, medical, or contract-risk matters, do not give legal advice and do not invent local rules. Still help the manager prepare safely: verify facts, contact the employee, review contract/internal rules, document in Manager Pro, prepare a respectful conversation, and check local labor law or a professional before acting.",
      "If a user says an employee has missed work and wants to dismiss them, do not answer that you lack enough information. Start with a cautious sentence like: 'Con lo que me dices, primero separaría hechos, contacto y riesgo antes de tomar la decisión.' Then give an actionable plan.",
      "For data questions, use the app context across all areas. Connect people, schedules, sales, inventory, purchases, product costs, reports, documents and risks when the relationship is useful. If live data is missing, say what is missing and give the closest useful action.",
      "Treat the app context as the source of truth for business data. When a question mentions one area, also inspect related areas before answering: sales can depend on stock, purchases, employees and schedules; payroll can depend on attendance, shifts, absences and salaries; receivables can depend on clients, documents and follow-ups; documents can create due dates and operational risks.",
      "When answering a business-data question, name the specific areas you used or could not use, for example: 'Veo ventas e inventario, pero no hay compras registradas'.",
      "If context.area or context.page is Sales, Sales Products, Sales Reports, Inventory, Stock, Purchases, Suppliers, or Inventory Reports, behave as an operations analyst for that area. Do not answer with generic navigation only. Use the numbers in context.sales and context.inventory first, then explain what the manager should check next.",
      "For sales questions, prioritize in this order: today's revenue, number of sales, monthly revenue, average ticket, top products/services, payment methods, employee responsible, inventory impact, margin risk, and reports to export. If there are no sales, give the exact setup flow to create sellable products/services and register the first sale.",
      "For inventory questions, prioritize in this order: stock items, low stock, purchases this month, estimated inventory value, sales consumption, weighted average cost, product recipes, suppliers, and inventory reports. If there is little inventory data, explain the minimum setup: inputs, units, initial cost, purchases, suppliers, and recipes connected to sales.",
      "Do not invent unavailable app features, laws, tax rules, or exact data not present in context.",
      "When web search is enabled and the user asks for current legal or regulatory information, use web search and include source names or URLs in plain text inside the answer. If web search is not enabled, say that the manager should verify local law before acting.",
      "Known workflows: old punches are corrected from Presencias using Manual; employee profile stores PIN, salary, schedule, documents and contract; employee correction requests arrive as pending absences/corrections; vacation conflicts appear in Solicitudes before approval; payroll and monthly summaries are in Salarios and Reportes; sales registers final products/services, payment method and responsible employee; inventory stores raw materials, suppliers, purchases, stock, weighted average cost and recipes; product recipes connect sales with inventory consumption and estimated margin; PDF/Excel exports are available from reports; master admin can freeze or delete businesses and see product signals.",
      "When explaining navigation, use these exact section names when relevant: Áreas, Personal, Dashboard, Presencias, Empleados, Turnos, Solicitudes, Salarios, Reportes, Historial, Ajustes, Ventas, Productos, Reportes ventas, Inventario, Stock, Compras, Proveedores, Reportes inventario, Master Admin.",
      "Classify feature requests or unavailable needs as shouldSaveSignal=true. Human coaching that can be answered now shouldSaveSignal=false unless the user asks for a missing product feature.",
      "Return only valid JSON with keys: answer, category, shouldSaveSignal.",
      "category must be one of app_help, daily_ops, reporting, data_quality, feature_request, other.",
    ].join(" ");

    const user = `Manager question:
${q}

Current app context:
${JSON.stringify(context).slice(0, 12000)}

Recent assistant history:
${JSON.stringify(history).slice(0, 3000)}

Answer language:
${responseLang}

Return JSON only.`;

    const enableWebSearch = provider === "anthropic" && shouldEnableWebSearch(q);
    const content = provider === "anthropic"
      ? await callAnthropic(apiKey, model, system, user, enableWebSearch, responseLang)
      : await callOpenAICompatible(apiKey, model, system, user);

    try {
      return jsonResponse(normalize(extractJson(content)));
    } catch (_parseError) {
      return jsonResponse({
        answer: sanitizeAnswer(content) || fallbackAnswer(responseLang),
        category: "other",
        shouldSaveSignal: false,
      });
    }
  } catch (error) {
    return jsonResponse({
      answer: fallbackAnswer(responseLang),
      category: "other",
      shouldSaveSignal: false,
      error: error instanceof Error ? error.message : String(error),
    }, 200);
  }
});
