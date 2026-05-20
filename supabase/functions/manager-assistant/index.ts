const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type AssistantResult = {
  answer: string;
  category: "app_help" | "daily_ops" | "reporting" | "data_quality" | "feature_request" | "other";
  shouldSaveSignal: boolean;
};

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
    answer: String(input.answer || "No tengo suficiente información para responder eso con seguridad."),
    category: ["app_help", "daily_ops", "reporting", "data_quality", "feature_request", "other"].includes(category) ? category : "other",
    shouldSaveSignal: Boolean(input.shouldSaveSignal),
  };
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
      max_tokens: 900,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
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
      temperature: 0.2,
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
      "You are the internal assistant for Mananger Pro, a simple staff management app for small businesses.",
      "Answer in the user's language, based only on app context and known Mananger Pro capabilities.",
      "Do not invent features, laws, tax advice, or unavailable data.",
      "If the app cannot answer, say what is missing and suggest the closest useful action.",
      "Known workflows: old punches are corrected from Presencias using Manual; employee profile stores PIN, salary, schedule, documents and contract; employee correction requests arrive as pending absences/corrections; vacation conflicts appear in Ausencias before approval; payroll and monthly summaries are in Salarios and Reportes; PDF/Excel exports are available from reports; master admin can freeze or delete restaurants and see product signals.",
      "When explaining navigation, use these exact section names when relevant: Dashboard, Presencias, Empleados, Turnos, Ausencias, Salarios, Reportes, Historial, Ajustes, Master Admin.",
      "Classify feature requests or unavailable needs as shouldSaveSignal=true.",
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

    const content = provider === "anthropic"
      ? await callAnthropic(apiKey, model, system, user)
      : await callOpenAICompatible(apiKey, model, system, user);

    return jsonResponse(normalize(extractJson(content)));
  } catch (error) {
    return jsonResponse({
      answer: "No pude consultar la IA en este momento. Puedo seguir ayudando con respuestas básicas dentro de la app.",
      category: "other",
      shouldSaveSignal: false,
      error: error instanceof Error ? error.message : String(error),
    }, 200);
  }
});
