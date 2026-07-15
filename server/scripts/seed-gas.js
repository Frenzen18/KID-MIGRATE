/**
 * Seeds one sample GAS (Goal Attainment Scaling) questionnaire set per discipline
 * (Speech-Language Therapy, Occupational Therapy), populated from the worked
 * examples in GAS_Assessment_Tool_Speech_Language.docx / GAS_Assessment_Tool_
 * Occupational_Therapy.docx. Each set is created as 'active' so it's immediately
 * selectable in Milestone Scoreboard → GAS Scorecard Input.
 *
 * Run AFTER migration_gas_assessment.sql has been applied:  node scripts/seed-gas.js
 * Safe to re-run: skips a discipline if a set with the same name already exists.
 */
import { db } from '../supabase.js';

const SETS = [
  {
    discipline: 'Speech-Language Therapy',
    name: 'Sample Set: Worked Examples (v1)',
    items: [
      {
        title: 'Articulation, /s/ sound in conversation',
        description: '/s/ sound production in conversational speech',
        weight: 3,
        level_m2: 'Produces /s/ correctly only in isolation with maximum cueing; not attempted in words.',
        level_m1: 'Produces /s/ correctly in single words with moderate cueing, less than 25% accuracy.',
        level_0: 'Produces /s/ correctly in structured sentences with minimal cueing, at least 60% accuracy (expected outcome by review date).',
        level_p1: 'Produces /s/ correctly in structured sentences independently, and inconsistently in spontaneous conversation.',
        level_p2: 'Produces /s/ correctly in spontaneous conversation independently, at least 80% accuracy across settings.'
      },
      {
        title: 'Receptive Language, following two-step directions',
        description: 'Following two-step spoken directions without gesture cues',
        weight: 2,
        level_m2: 'Follows one-step directions only with a gesture cue; two-step directions not attempted.',
        level_m1: 'Follows one-step directions verbally; two-step directions only with repetition or gesture cues.',
        level_0: 'Follows two-step spoken directions without gesture cues in structured tasks, at least 70% accuracy (expected outcome by review date).',
        level_p1: 'Follows two-step directions independently in structured tasks, inconsistently at home/school.',
        level_p2: 'Follows two- and three-step directions independently across settings.'
      },
      {
        title: 'Expressive Language, complete simple sentences',
        description: 'Use of grammatically complete simple sentences',
        weight: 3,
        level_m2: 'Uses single words or two-word combinations only; no sentence attempts.',
        level_m1: 'Combines 3-4 words inconsistently, frequently omitting grammatical markers, with maximum cueing.',
        level_0: 'Uses grammatically complete simple sentences in structured tasks, at least 60% of utterances, with minimal cueing (expected outcome by review date).',
        level_p1: 'Uses complete simple sentences independently in structured tasks, inconsistently in spontaneous conversation.',
        level_p2: 'Uses grammatically complete sentences independently across structured and spontaneous conversation, at least 80% of utterances.'
      },
      {
        title: 'Pragmatics, conversational turn-taking',
        description: 'Turn-taking in reciprocal conversation',
        weight: 2,
        level_m2: "Does not respond to a communication partner's turn even with prompting.",
        level_m1: "Responds to a partner's turn only with maximum verbal or gestural prompting.",
        level_0: 'Initiates and responds appropriately in at least 4 of 6 conversational exchanges with minimal prompting (expected outcome by review date).',
        level_p1: 'Initiates and responds appropriately in most exchanges with occasional prompting.',
        level_p2: 'Sustains reciprocal conversation independently across at least 8 exchanges without prompting.'
      }
    ]
  },
  {
    discipline: 'Occupational Therapy',
    name: 'Sample Set: Worked Examples (v1)',
    items: [
      {
        title: 'Fine Motor, pencil grasp for handwriting',
        description: 'Functional pencil grasp during handwriting tasks',
        weight: 3,
        level_m2: 'Uses a fisted or immature palmar grasp on writing tools; unable to form recognizable letters.',
        level_m1: 'Uses an immature grasp with hand-over-hand guidance; forms some letters with significant support.',
        level_0: 'Uses a functional tripod or modified grasp independently to write name and simple words, legible at least 60% of the time (expected outcome by review date).',
        level_p1: 'Uses a mature tripod grasp independently for short writing tasks, with occasional fatigue or posture reminders.',
        level_p2: 'Uses a mature, efficient grasp independently across extended writing tasks without fatigue or reminders.'
      },
      {
        title: 'Gross Motor / Functional Mobility, stair navigation',
        description: 'Independent stair navigation',
        weight: 2,
        level_m2: 'Requires full physical assistance from an adult to navigate stairs.',
        level_m1: 'Navigates stairs one step at a time with hand-held assistance and a railing.',
        level_0: 'Navigates stairs independently using a railing, alternating feet, in at least 4 of 5 attempts (expected outcome by review date).',
        level_p1: 'Navigates stairs independently using a railing without alternating-foot difficulty, most attempts.',
        level_p2: 'Navigates stairs independently without a railing, alternating feet consistently.'
      },
      {
        title: 'Sensory Processing, texture tolerance',
        description: 'Tolerance of varied food or clothing textures',
        weight: 2,
        level_m2: 'Refuses or shows significant distress when presented with non-preferred textures; task cannot proceed.',
        level_m1: 'Tolerates brief contact with non-preferred textures only with heavy adult support and reassurance.',
        level_0: 'Tolerates non-preferred textures for a full structured activity (5-10 minutes) with minimal support, in at least 3 of 5 sessions (expected outcome by review date).',
        level_p1: 'Tolerates non-preferred textures independently in structured activities, using self-regulation strategies occasionally.',
        level_p2: 'Tolerates and engages with varied textures independently across structured and unstructured settings.'
      },
      {
        title: 'Self-Care / ADL, independent dressing (buttoning)',
        description: 'Independent buttoning during dressing tasks',
        weight: 3,
        level_m2: 'Requires full physical assistance to button any clothing item.',
        level_m1: 'Attempts buttoning with hand-over-hand guidance; completes less than 25% independently.',
        level_0: 'Buttons large buttons independently with occasional verbal cueing, at least 70% success rate (expected outcome by review date).',
        level_p1: 'Buttons large and medium buttons independently without cueing.',
        level_p2: 'Buttons all button sizes independently, including small buttons, without cueing or excessive time.'
      }
    ]
  }
];

async function main() {
  for (const set of SETS) {
    const { data: existing } = await db.from('gas_questionnaires')
      .select('id').eq('discipline', set.discipline).eq('name', set.name).maybeSingle();
    if (existing) {
      console.log(`- skipping "${set.name}" (${set.discipline}), already exists`);
      continue;
    }

    const { data: created, error } = await db.from('gas_questionnaires')
      .insert({ discipline: set.discipline, name: set.name, status: 'active' })
      .select().single();
    if (error) throw new Error(`${set.discipline} questionnaire: ${error.message}`);

    const rows = set.items.map((it, i) => ({ ...it, questionnaire_id: created.id, sort_order: i }));
    const { error: itemsErr } = await db.from('gas_questionnaire_items').insert(rows);
    if (itemsErr) throw new Error(`${set.discipline} items: ${itemsErr.message}`);

    console.log(`✔ ${set.discipline}: "${set.name}", ${rows.length} goals`);
  }
  console.log('\n✔ GAS sample seed complete.');
}

main().catch(e => { console.error('\n✖ GAS seed failed:', e.message); process.exit(1); });
