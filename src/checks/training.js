import { REPO_URL } from '../config.js';

const ID = 'training';
const TEXT = {
  'claude-code': 'Check Model Improvement at https://claude.ai/settings/data-privacy-controls',
  codex: 'Check data controls: https://help.openai.com/en/articles/7730893-data-controls-faq',
  gemini:
    'Check https://myactivity.google.com/product/gemini and the data-use terms of the plan or API key you use',
  cursor: 'Check Privacy Mode: https://cursor.com/data-use',
};

function run(ctx) {
  const rows = [];
  for (const a of ctx.agents) {
    if (TEXT[a.id]) rows.push({ agent: a.id, status: 'info', message: TEXT[a.id] });
  }
  if (rows.length === 0) {
    rows.push({ agent: 'system', status: 'skip', message: 'No coding agent detected' });
  }
  return rows;
}

export default {
  id: ID,
  title: 'Your chats may be used for training',
  severity: 'info',
  docs: [`${REPO_URL}#${ID}`],
  run,
};
