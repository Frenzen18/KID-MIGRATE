import { VertexAI } from '@google-cloud/vertexai';

const PROJECT = process.env.GCP_PROJECT_ID;
const LOCATION = process.env.GCP_LOCATION || 'us-central1';

let vertexAI = null;
function getClient() {
  if (!PROJECT) throw new Error('GCP_PROJECT_ID is not set');
  if (!vertexAI) vertexAI = new VertexAI({ project: PROJECT, location: LOCATION });
  return vertexAI;
}

/** Renders a goal's score into one plain-language line, e.g.
 *  '- Fine Motor — Pencil Grasp (weight x2): scored +1 — "Uses tripod grasp with occasional cueing"' */
function formatGoalLine(g) {
  const sign = g.level > 0 ? `+${g.level}` : String(g.level);
  return `- ${g.item_title} (weight x${g.weight}): scored ${sign} — "${g.level_label}"`;
}

/** The prompt lives here in code, not exposed to any UI, per the "trust only the
 *  given variables" requirement. Every value it can reference is passed in
 *  explicitly, nothing is fetched or inferred by the model itself. */
function buildPrompt({ clientName, clientCode, discipline, sessionDate, therapistName, tScore, goals, parentObservation, remarks }) {
  const goalsBlock = goals.length ? goals.map(formatGoalLine).join('\n') : '(no goals recorded)';
  return `You are a licensed pediatric therapist writing a short, plain-language progress summary for a Goal Attainment Scaling (GAS) session.

STRICT RULES:
- Use ONLY the data provided below. Do not add, assume, invent, or infer anything not explicitly present.
- Do not include any clinical claim, diagnosis, or recommendation that is not directly supported by the data given.
- If a field below is empty or says "(none provided)", leave the corresponding output field as an empty string — do not make something up to fill it.
- Write for a parent/guardian with no clinical background: short sentences, no jargon, no acronyms without explanation.
- Return ONLY valid JSON matching the exact shape below. No markdown, no code fences, no commentary outside the JSON.

SESSION DATA:
Child: ${clientName} (${clientCode})
Discipline: ${discipline}
Session Date: ${sessionDate}
Therapist: ${therapistName || '(none provided)'}
Overall GAS T-Score: ${tScore ?? '(none provided)'} (50 = progressing exactly as expected; above 50 = better than expected; below 50 = behind expected)

Goals Scored:
${goalsBlock}

Parent Observation: ${parentObservation || '(none provided)'}

Therapist Remarks / Plan: ${remarks || '(none provided)'}

Return exactly this JSON shape:
{
  "overallSummary": "1-2 sentence plain-language overview of how this session went. The exact T-score number is already shown separately, so describe what it means (e.g. progressing as expected / better than expected / behind expected) rather than repeating the number itself",
  "goalProgress": [{ "goal": "<goal title, copied exactly from the data above>", "result": "<one plain-language sentence on that goal's score and level>" }],
  "parentObservationNote": "<a clean, plain-language restatement of the parent's observation, or empty string if none was provided>",
  "therapistRemarksNote": "<a clean, plain-language restatement of the therapist's remarks/plan, or empty string if none was provided>"
}`;
}

/** Generates a structured, parent-readable summary of one GAS scorecard entry.
 *  `entryData` must only contain values pulled directly from the entry/client
 *  records — never user-typed free text meant to steer the model. */
export async function generateGasSummary(entryData) {
  const model = getClient().getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
  });

  const prompt = buildPrompt(entryData);
  const result = await model.generateContent(prompt);
  const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Gemini returned non-JSON output');
  }
  return parsed;
}
