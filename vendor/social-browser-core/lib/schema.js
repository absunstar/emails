'use strict';

const { getPath } = require('./utils');

function typeOk(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'date') return value instanceof Date || !Number.isNaN(Date.parse(value));
  return typeof value === type;
}

function validate(schema, doc, options = {}) {
  const errors = [];
  if (!schema) return { valid:true, errors };

  const required = schema.required || [];
  for (const field of required) {
    const v = getPath(doc, field);
    if (v === undefined || v === null || v === '') errors.push({field, code:'required', message:`${field} is required`});
  }

  const props = schema.properties || {};
  for (const [field, rule] of Object.entries(props)) {
    const value = getPath(doc, field);
    if (value === undefined) continue;
    if (rule.type && ![].concat(rule.type).some(t => typeOk(value,t))) {
      errors.push({field, code:'type', expected:rule.type, actual:Array.isArray(value)?'array':typeof value});
      continue;
    }
    if (typeof value === 'string') {
      if (rule.minLength != null && value.length < rule.minLength) errors.push({field,code:'minLength'});
      if (rule.maxLength != null && value.length > rule.maxLength) errors.push({field,code:'maxLength'});
      if (rule.pattern && !(new RegExp(rule.pattern)).test(value)) errors.push({field,code:'pattern'});
      if (rule.enum && !rule.enum.includes(value)) errors.push({field,code:'enum'});
    }
    if (typeof value === 'number') {
      if (rule.minimum != null && value < rule.minimum) errors.push({field,code:'minimum'});
      if (rule.maximum != null && value > rule.maximum) errors.push({field,code:'maximum'});
    }
    if (Array.isArray(value)) {
      if (rule.minItems != null && value.length < rule.minItems) errors.push({field,code:'minItems'});
      if (rule.maxItems != null && value.length > rule.maxItems) errors.push({field,code:'maxItems'});
    }
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(props));
    for (const key of Object.keys(doc || {})) {
      if (key.startsWith('_') || key === 'id') continue;
      if (!allowed.has(key)) errors.push({field:key,code:'additionalProperty'});
    }
  }

  return { valid:errors.length===0, errors };
}

function assertValid(schema, doc) {
  const r = validate(schema, doc);
  if (!r.valid) {
    const e = new Error('Schema validation failed');
    e.code = 'SCHEMA_VALIDATION_FAILED';
    e.validationErrors = r.errors;
    throw e;
  }
  return true;
}

module.exports = { validate, assertValid };
