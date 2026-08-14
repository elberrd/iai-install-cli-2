import process from 'node:process';
import { DEFAULT_TEMPLATE_ID, TEMPLATES } from '../config.js';
import * as ui from '../lib/ui.js';

/**
 * Pure: which template do the flags ask for? Precedence: --template-id >
 * --tenancy (legacy shortcut) > null (ask / default). Does not validate
 * existence — that's the step's job (which has UI access for the friendly
 * error).
 * @returns {{id: string|null, source: 'template-id'|'tenancy'|'none'}}
 */
export function resolveTemplateId(flags = {}) {
  if (flags.templateId) return { id: String(flags.templateId), source: 'template-id' };
  if (flags.tenancy) {
    const match = Object.values(TEMPLATES).find((t) => t.tenancy === flags.tenancy);
    return { id: match ? match.id : null, source: 'tenancy' };
  }
  return { id: null, source: 'none' };
}

/**
 * Step: resolve the template variant and set `ctx.template` (a TEMPLATES
 * catalog entry). Interactive when no flag decided and more than one template
 * is available; `--yes` sticks to the default without asking.
 */
export async function selectTemplate(ctx) {
  const { flags = {} } = ctx;
  let { id } = resolveTemplateId(flags);

  if (id && !TEMPLATES[id]) {
    ui.error(`Unknown template: "${id}". Available: ${Object.keys(TEMPLATES).join(', ')}.`);
    process.exit(1);
  }

  if (!id) {
    const available = Object.values(TEMPLATES).filter((t) => t.available);
    if (flags.yes || available.length <= 1) {
      id = DEFAULT_TEMPLATE_ID;
    } else {
      id = await ui.select({
        message: 'Which template should I install?',
        initialValue: DEFAULT_TEMPLATE_ID,
        options: available.map((t) => ({ value: t.id, label: t.label, hint: t.hint })),
      });
    }
  }

  const template = TEMPLATES[id];
  if (!template.available) {
    ui.error(
      `The "${template.label}" template is unavailable right now. ` +
        'Pick another one or try again later.',
    );
    process.exit(1);
  }

  ctx.template = template;
  ui.info(`Template: ${template.label}.`);
}
