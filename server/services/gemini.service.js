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
 *  '- Fine Motor - Pencil Grasp (weight x2): scored +1, "Uses tripod grasp with occasional cueing"' */
function formatGoalLine(g) {
  const sign = g.level > 0 ? `+${g.level}` : String(g.level);
  return `- ${g.item_title} (weight x${g.weight}): scored ${sign}, "${g.level_label}"`;
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
- If a field below is empty or says "(none provided)", leave the corresponding output field as an empty string, do not make something up to fill it.
- Write for a parent/guardian with no clinical background: short sentences, no jargon, no acronyms without explanation.
- Return ONLY valid JSON matching the exact shape below. No markdown, no code fences, no commentary outside the JSON.
- Do not use em dashes (—) anywhere in the output, use commas or separate sentences instead.

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

/** Sends one prompt to Gemini and parses the JSON it's instructed to return, shared by every summary type below. */
async function runJsonPrompt(prompt) {
  const model = getClient().getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
  });
  const result = await model.generateContent(prompt);
  const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Gemini returned non-JSON output');
  }
}

/** Generates a structured, parent-readable summary of one GAS scorecard entry.
 *  `entryData` must only contain values pulled directly from the entry/client
 *  records, never user-typed free text meant to steer the model. */
export async function generateGasSummary(entryData) {
  return runJsonPrompt(buildPrompt(entryData));
}

/** One goal's trajectory across a report's date range, e.g.
 *  '- Fine Motor: pencil grasp for handwriting (weight x3): -2 -> 0 -> +1 across 4 session(s)' */
function formatGoalTrendLine(g) {
  const path = g.levels.map(l => (l > 0 ? `+${l}` : String(l))).join(' -> ');
  return `- ${g.title} (weight x${g.weight}): ${path} across ${g.levels.length} session(s)`;
}

/** The report prompt, same "trust only the given variables, no identity" contract
 *  as buildPrompt above. Nothing here ever includes the child's name or client
 *  code, only clinical data aggregated over the requested date range. */
function buildReportPrompt({ disciplines, fromDate, toDate, sessionCount, avgTScore, trend, goalTrends }) {
  const goalsBlock = goalTrends.length ? goalTrends.map(formatGoalTrendLine).join('\n') : '(no goals recorded in this range)';
  return `You are a licensed pediatric therapist writing the "Therapist Summary & Recommendations" section of a clinical progress report, covering multiple sessions over a date range.

STRICT RULES:
- Use ONLY the data provided below. Do not add, assume, invent, or infer anything not explicitly present.
- Do not include any clinical claim, diagnosis, or recommendation that is not directly supported by the data given.
- Never reference the child by name, this data is intentionally identity-withheld, refer to them only as "the client" or "the child".
- Write for a parent/guardian with no clinical background: short sentences, no jargon, no acronyms without explanation.
- Return ONLY valid JSON matching the exact shape below. No markdown, no code fences, no commentary outside the JSON.
- Do not use em dashes (—) anywhere in the output, use commas or separate sentences instead.

REPORT PERIOD DATA:
Discipline(s): ${disciplines.join(', ') || '(none provided)'}
Date Range: ${fromDate} to ${toDate}
Sessions in Range: ${sessionCount}
Average GAS T-Score: ${avgTScore ?? '(none provided)'} (50 = progressing exactly as expected; above 50 = better than expected; below 50 = behind expected)
T-Score Trend Across the Range: ${trend}

Goal Trends:
${goalsBlock}

Return exactly this JSON shape:
{
  "summary": "2-3 sentence plain-language overview of how the client progressed across this date range, referencing the T-score trend and any clear goal-level patterns",
  "recommendations": "2-3 sentence plain-language recommendation for continued therapy focus, based only on which goals are lagging or improving in the data above"
}`;
}

/** Generates the AI-assisted "Therapist Summary & Recommendations" for a client
 *  report spanning multiple sessions. `reportData` is pre-aggregated, identity-
 *  withheld clinical data, see buildReportPrompt for the exact contract. */
export async function generateReportSummary(reportData) {
  return runJsonPrompt(buildReportPrompt(reportData));
}
