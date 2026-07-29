/**
 * The GAS entry `remarks` field can hold either a plain free-text note (older/manual
 * entries) or the structured multi-section blob produced by the Scorecard wizard's
 * "Generate Summary" step (Overall GAS T-Score / Goal Progress / Parent Observation /
 * Plans, Analysis, and Instructions, each its own paragraph). Anything that displays
 * `remarks` needs to tell these apart instead of dumping the whole blob as one wall
 * of text.
 */
export function parseGasRemarks(remarks) {
  const text = (remarks || '').trim();
  const empty = { overallSummary: '', goalProgress: [], parentObservation: '', plansInstructions: '', freeText: '' };
  if (!text) return empty;

  const paragraphs = text.split(/\n\n+/);
  let overallSummary = '', parentObservation = '', plansInstructions = '';
  let goalProgress = [];
  const leftovers = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (/^Parent observation:\s*/i.test(trimmed)) {
      parentObservation = parentObservation || trimmed.replace(/^Parent observation:\s*/i, '');
    } else if (/^Goal Progress:/.test(trimmed)) {
      goalProgress = trimmed.replace(/^Goal Progress:\s*/, '').split('\n').map(l => l.replace(/^-\s*/, '').trim()).filter(Boolean);
    } else if (/^Plans, Analysis, and Instructions:/.test(trimmed)) {
      plansInstructions = trimmed.replace(/^Plans, Analysis, and Instructions:\s*/, '').trim();
    } else if (/^Overall GAS T-Score:/.test(trimmed)) {
      overallSummary = trimmed.split('\n').slice(1).join(' ').trim();
    } else {
      leftovers.push(trimmed);
    }
  }
  return { overallSummary, goalProgress, parentObservation, plansInstructions, freeText: leftovers.join('\n\n') };
}

/** Short preview line for hover tooltips: the most relevant single note, truncated. */
export function gasRemarksPreview(remarks, maxLen = 150) {
  const { plansInstructions, overallSummary, freeText } = parseGasRemarks(remarks);
  const note = plansInstructions || overallSummary || freeText;
  if (!note) return '';
  return note.length > maxLen ? note.slice(0, maxLen).trimEnd() + '…' : note;
}
