import type { ModelDef } from '../types.js';
import { choices } from '../types.js';
import { addError, colorF, count, descriptionF, nameF, slugF } from './common.js';

export const CUSTOM_FIELD_TYPES = choices(
  'text',
  ['longtext', 'Text (long)'],
  'integer',
  'decimal',
  'boolean',
  'date',
  ['url', 'URL'],
  'select',
  ['multiselect', 'Multiple select'],
  ['json', 'JSON'],
);

export const extrasModels: ModelDef[] = [
  {
    type: 'extras.tag',
    app: 'extras',
    path: 'tags',
    table: 'nb_tags',
    verbose: 'tag',
    verbosePlural: 'tags',
    fields: [nameF(), slugF, colorF('9e9e9e'), descriptionF],
    unique: [['name'], ['slug']],
    brief: ['name', 'slug', 'color'],
    display: (r) => r.name,
    ordering: ['name'],
    taggable: false,
    customFields: false,
    serializeExtra: (r, ctx) => ({ tagged_items: count(ctx, 'SELECT COUNT(*) n FROM nb_tagged WHERE tag_id = ?', r.id) }),
  },
  {
    type: 'extras.customfield',
    app: 'extras',
    path: 'custom-fields',
    table: 'nb_custom_fields',
    verbose: 'custom field',
    verbosePlural: 'custom fields',
    fields: [
      { name: 'object_types', kind: 'json', required: true },
      { name: 'type', kind: 'choice', choices: CUSTOM_FIELD_TYPES, required: true, default: 'text' },
      { name: 'name', kind: 'string', required: true, maxLength: 50, search: true },
      { name: 'label', kind: 'string', maxLength: 50, search: true },
      descriptionF,
      { name: 'required', kind: 'bool' },
      { name: 'default', kind: 'json' },
      { name: 'weight', kind: 'int', default: 100, min: 0 },
      { name: 'choices', kind: 'json' },
      { name: 'validation_minimum', kind: 'int' },
      { name: 'validation_maximum', kind: 'int' },
      { name: 'validation_regex', kind: 'string', maxLength: 500 },
    ],
    unique: [['name']],
    brief: ['name'],
    display: (r) => r.label || r.name,
    ordering: ['weight', 'name'],
    taggable: false,
    customFields: false,
    validate(rec, errors, ctx) {
      if (rec.name != null && !/^[a-z0-9_]+$/.test(rec.name)) addError(errors, 'name', 'Only lowercase letters, digits and underscores are allowed.');
      const types = rec.object_types;
      if (!Array.isArray(types) || types.length === 0 || types.some((t) => typeof t !== 'string')) {
        addError(errors, 'object_types', 'Provide a list of object types, e.g. ["dcim.device"].');
      } else {
        for (const t of types) if (!ctx.knownType(t)) addError(errors, 'object_types', `Unknown object type "${t}".`);
      }
      if (rec.type === 'select' || rec.type === 'multiselect') {
        if (!Array.isArray(rec.choices) || rec.choices.length === 0 || rec.choices.some((c: unknown) => typeof c !== 'string')) {
          addError(errors, 'choices', 'Selection fields need a list of string choices.');
        }
      } else if (rec.choices != null) {
        rec.choices = null;
      }
      if (rec.validation_regex) {
        try {
          new RegExp(rec.validation_regex);
        } catch {
          addError(errors, 'validation_regex', 'Invalid regular expression.');
        }
      }
    },
  },
  {
    type: 'extras.objectchange',
    app: 'extras',
    path: 'object-changes',
    table: 'nb_changelog',
    verbose: 'object change',
    verbosePlural: 'object changes',
    fields: [
      { name: 'user_id', kind: 'string' },
      { name: 'user_name', kind: 'string', search: true },
      { name: 'request_id', kind: 'string' },
      { name: 'action', kind: 'choice', choices: choices('create', 'update', 'delete') },
      { name: 'changed_object_type', kind: 'string' },
      { name: 'changed_object_id', kind: 'int' },
      { name: 'object_repr', kind: 'string', search: true },
      { name: 'prechange_data', kind: 'json' },
      { name: 'postchange_data', kind: 'json' },
    ],
    indexes: ['changed_object_type, changed_object_id'],
    brief: ['action', 'changed_object_type', 'changed_object_id'],
    display: (r) => `${r.object_repr} (${r.action})`,
    ordering: ['-created'],
    taggable: false,
    customFields: false,
    readOnlyModel: true,
    serializeExtra: (r) => ({ time: r.created }),
  },
];
