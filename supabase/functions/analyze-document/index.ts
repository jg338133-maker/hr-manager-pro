const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type DocumentAnalysis = {
  summary: string;
  documentType: string | null;
  folder: string | null;
  counterparty: string | null;
  amount: string | null;
  currency: string | null;
  relevantData: string[];
  dates: Array<{ label: string; date: string; risk: "low" | "medium" | "high" }>;
  responsiblePeople: string[];
  obligations: string[];
  warnings: string[];
  suggestedExpiry: string | null;
  confidence: "high" | "medium" | "low";
};

const emptyResult = (): DocumentAnalysis => ({
  summary: "",
  documentType: null,
  folder: null,
  counterparty: null,
  amount: null,
  currency: null,
  relevantData: [],
  dates: [],
  responsiblePeople: [],
  obligations: [],
  warnings: [],
  suggestedExpiry: null,
  confidence: "low",
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

function normalizeArray(value: unknown) {
  return Array.isArray(value) ? value.map((x) => String(x)).filter(Boolean).slice(0, 10) : [];
}

function normalizeResult(input: Record<string, unknown>): DocumentAnalysis {
  const out = emptyResult();
  out.summary = String(input.summary || "").slice(0, 700);
  out.documentType = input.documentType ? String(input.documentType).slice(0, 80) : null;
  out.folder = input.folder ? String(input.folder).slice(0, 80) : null;
  out.counterparty = input.counterparty ? String(input.counterparty).slice(0, 120) : null;
  out.amount = input.amount ? String(input.amount).slice(0, 80) : null;
  out.currency = input.currency ? String(input.currency).slice(0, 12) : null;
  out.relevantData = normalizeArray(input.relevantData);
  out.responsiblePeople = normalizeArray(input.responsiblePeople);
  out.obligations = normalizeArray(input.obligations);
  out.warnings = normalizeArray(input.warnings);
  out.suggestedExpiry = input.suggestedExpiry ? String(input.suggestedExpiry).slice(0, 10) : null;
  out.confidence = ["high", "medium", "low"].includes(String(input.confidence))
    ? input.confidence as DocumentAnalysis["confidence"]
    : "low";
  out.dates = Array.isArray(input.dates)
    ? input.dates.slice(0, 8).map((d) => {
        const row = (d || {}) as Record<string, unknown>;
        const risk = ["low", "medium", "high"].includes(String(row.risk)) ? String(row.risk) : "medium";
        return {
          label: String(row.label || "Date").slice(0, 80),
          date: String(row.date || "").slice(0, 10),
          risk: risk as "low" | "medium" | "high",
        };
      }).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date))
    : [];
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
  if (!aiRes.ok) throw new Error(`AI request failed: ${await aiRes.text()}`);
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
  if (!aiRes.ok) throw new Error(`Anthropic request failed: ${await aiRes.text()}`);
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
    const { text = "", fileName = "document", documentType = "other", folder = "business" } = await req.json();
    const documentText = String(text || "").slice(0, 18000);
    if (!documentText.trim()) return jsonResponse({
      ...emptyResult(),
      summary: "No pude leer texto suficiente del archivo. Revisa el documento manualmente.",
      documentType: String(documentType || "other"),
      folder: String(folder || "business"),
      warnings: ["Texto no legible o archivo escaneado con baja calidad."],
    });

    const system = [
      "You analyze small-business documents for a business management app.",
      "Documents can be employment contracts, lease/rent contracts, permits, recipes, operating procedures, supplier agreements, invoices, insurance documents, tax files, or internal policies.",
      "The document may be in Spanish, French, Italian, German, or English.",
      "Return only valid JSON. No markdown. No explanation.",
      "Do not invent facts. If something is not present, omit it or use null.",
      "Dates must be YYYY-MM-DD. If a date is ambiguous, add a warning instead of guessing.",
      "Keep the summary practical for a manager.",
    ].join(" ");

    const user = `Analyze this business document.

File name: ${fileName}
Current document type hint: ${documentType}
Current folder hint: ${folder}

Return this exact JSON shape:
{
  "summary": "",
  "documentType": null,
  "folder": null,
  "counterparty": null,
  "amount": null,
  "currency": null,
  "relevantData": [],
  "dates": [{"label": "", "date": "YYYY-MM-DD", "risk": "low"}],
  "responsiblePeople": [],
  "obligations": [],
  "warnings": [],
  "suggestedExpiry": null,
  "confidence": "medium"
}

Guidance:
- summary: 2-4 short sentences.
- documentType: practical label such as employment_contract, lease_contract, supplier_agreement, permit, recipe, operating_procedure, insurance, invoice, tax, other.
- folder: employees, company, lease, operations, recipes, suppliers, finance, other.
- counterparty: supplier, landlord, employee, customer, authority, or other external/internal party when present.
- amount and currency: main money value when clearly present, for example rent, salary, invoice total, purchase amount, insurance premium, or fee.
- relevantData: amounts, addresses, IDs, contract parties, product/process names, payment terms, notice periods, quantities, or other useful facts.
- dates: include start date, end date, renewal, expiry, payment due date, review date, or inspection date when present.
- responsiblePeople: names or roles responsible.
- obligations: concrete obligations or actions the manager should remember.
- warnings: risks, missing signatures, ambiguous dates, missing responsible person, missing expiry, or unclear pages.
- suggestedExpiry: the most important expiry/review date if present, else null.

DOCUMENT:
${documentText}`;

    const content = provider === "anthropic"
      ? await callAnthropic(apiKey, model, system, user)
      : await callOpenAICompatible(apiKey, model, system, user);
    return jsonResponse(normalizeResult(extractJson(content)));
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
