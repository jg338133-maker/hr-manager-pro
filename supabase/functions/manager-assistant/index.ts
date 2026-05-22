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
  return /\b(ley|legal|derecho|contrato|desped|indemniz|preaviso|aviso|norma|regla|suiza|swiss|suisse|arbeitsrecht|licenciement|licenziamento|dismiss|termination|law|legal)\b/i.test(question);
}

async function callAnthropic(apiKey: string, model: string, system: string, user: string, enableWebSearch: boolean) {
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
  if (!aiRes.ok && enableWebSearch) return callAnthropic(apiKey, model, system, user, false);
  if (!aiRes.ok) throw new Error(`Anthropic request failed: ${await aiRes.text()}`);
  const payload = await aiRes.json();
  return (payload?.content || [])
    .filter((part: { type?: string; text?: string }) => part.type === "text")
    .map((part: { text?: string }) => part.text || "")
    .join("\n") || "{}";
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const apiKey = Deno.env.get("AI_API_KEY") || Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) return jsonResponse({ error: "Missing AI_API_KEY secret" }, 500);

    const provider = (Deno.env.get("AI_PROVIDER") || (apiKey.startsWith("sk-ant-") ? "anthropic" : "openai")).toLowerCase();
    const model = Deno.env.get("AI_MODEL") || Deno.env.get("OPENAI_MODEL") || (provider === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o-mini");
    const { question = "", context = {}, history = [] } = await req.json();
    const q = String(question || "").trim();
    if (!q) return jsonResponse({ error: "Question is required" }, 400);

    const system = [
      "You are the internal assistant for Manager Pro, a simple staff management app for small businesses.",
      "Answer in the user's language. If context.lang is es/fr/en/de/it, use that language.",
      "Write in plain text only. Do not use Markdown formatting. Never use bold markers, headings, tables, code fences, or markdown links. Numbered steps are allowed.",
      "You are not only a software manual. You are also a calm operational coach for small-business managers who may need help with soft conversations, accountability, punctuality, conflict, motivation, and follow-up.",
      "For human/team questions, do not say this is outside the app. Give a practical manager-ready answer: empathic framing, concrete talking points, questions to ask the employee, a simple agreement, follow-up timing, and how to document facts in Manager Pro.",
      "Keep advice humane and direct. Avoid shaming the employee. Separate facts, impact, cause, agreement, and follow-up.",
      "For dismissal, termination, formal discipline, legal, payroll, tax, medical, or contract-risk matters, do not give legal advice and do not invent local rules. Still help the manager prepare safely: verify facts, contact the employee, review contract/internal rules, document in Manager Pro, prepare a respectful conversation, and check local labor law or a professional before acting.",
      "If a user says an employee has missed work and wants to dismiss them, do not answer that you lack enough information. Start with a cautious sentence like: 'Con lo que me dices, primero separaría hechos, contacto y riesgo antes de tomar la decisión.' Then give an actionable plan.",
      "For data questions, use the app context. If live data is missing, say what is missing and give the closest useful action.",
      "Do not invent unavailable app features, laws, tax rules, or exact data not present in context.",
      "When web search is enabled and the user asks for current legal or regulatory information, use web search and include source names or URLs in plain text inside the answer. If web search is not enabled, say that the manager should verify local law before acting.",
      "Known workflows: old punches are corrected from Presencias using Manual; employee profile stores PIN, salary, schedule, documents and contract; employee correction requests arrive as pending absences/corrections; vacation conflicts appear in Ausencias before approval; payroll and monthly summaries are in Salarios and Reportes; PDF/Excel exports are available from reports; master admin can freeze or delete restaurants and see product signals.",
      "When explaining navigation, use these exact section names when relevant: Dashboard, Presencias, Empleados, Turnos, Ausencias, Salarios, Reportes, Historial, Ajustes, Master Admin.",
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

Return JSON only.`;

    const enableWebSearch = provider === "anthropic" && shouldEnableWebSearch(q);
    const content = provider === "anthropic"
      ? await callAnthropic(apiKey, model, system, user, enableWebSearch)
      : await callOpenAICompatible(apiKey, model, system, user);

    return jsonResponse(normalize(extractJson(content)));
  } catch (error) {
    return jsonResponse({
      answer: "No pude consultar la IA en este momento. Puedo seguir ayudando con respuestas basicas dentro de la app.",
      category: "other",
      shouldSaveSignal: false,
      error: error instanceof Error ? error.message : String(error),
    }, 200);
  }
});
