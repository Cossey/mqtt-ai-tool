import { sanitizeOutgoingTopic, extractStructuredFromAiResponse, composeTemplateChain, buildJsonSchema } from '../src/utils/promptUtils';

describe('sanitizeOutgoingTopic', () => {
  test('accepts valid simple topic', () => {
    expect(sanitizeOutgoingTopic('BACKYARD-SECURITY')).toBe('BACKYARD-SECURITY');
  });

  test('trims slashes and spaces, preserving segments', () => {
    expect(sanitizeOutgoingTopic('/BACKYARD/SECURITY/')).toBe('BACKYARD/SECURITY');
  });

  test('sanitizes segments and preserves slash separator', () => {
    expect(sanitizeOutgoingTopic('Back/yard:weird')).toBe('Back/yard_weird');
  });

  test('rejects wildcards', () => {
    expect(sanitizeOutgoingTopic('BAD/#')).toBeNull();
    expect(sanitizeOutgoingTopic('BAD/+/TOPIC')).toBeNull();
  });

  test('rejects control chars', () => {
    expect(sanitizeOutgoingTopic('BAD\u0000TOPIC')).toBeNull();
  });
});

describe('extractStructuredFromAiResponse', () => {
  test('returns top-level output object', () => {
    const resp = { output: { a: 1 } };
    expect(extractStructuredFromAiResponse(resp)).toEqual({ a: 1 });
  });

  test('parses JSON string in choices', () => {
    const resp = { choices: [{ message: { content: '{"x":2}' } }] };
    expect(extractStructuredFromAiResponse(resp)).toEqual({ x: 2 });
  });

  test('returns null for free text', () => {
    const resp = { choices: [{ message: { content: 'hello world' } }] };
    expect(extractStructuredFromAiResponse(resp)).toBeNull();
  });
});

describe('composeTemplateChain', () => {
  test('concatenates two templates by appending', () => {
    const prompts = {
      t1: { prompt: 'First' },
      t2: { prompt: 'Second' }
    } as any;
    const res = composeTemplateChain(['t1','t2'], prompts);
    expect(res.text).toBe('First\n\nSecond');
  });

  test('inserts template into {{template}} placeholder', () => {
    const prompts = {
      t1: { prompt: 'Outer: {{template}}' },
      t2: { prompt: 'Inner' }
    } as any;
    const res = composeTemplateChain(['t1','t2'], prompts);
    expect(res.text).toBe('Outer: Inner');
  });

  test('nested placeholders', () => {
    const prompts = {
      t1: { prompt: 'A {{template}} Z' },
      t2: { prompt: 'B {{template}} Y' },
      t3: { prompt: 'C' }
    } as any;
    const res = composeTemplateChain(['t1','t2','t3'], prompts);
    expect(res.text).toBe('A B C Y Z');
  });

  test('model selection uses last-wins (rightmost overrides)', () => {
    const prompts = {
      t1: { prompt: 'First', model: 'm1' },
      t2: { prompt: 'Second', model: 'm2' }
    } as any;
    const res = composeTemplateChain(['t1','t2'], prompts);
    expect(res.model).toBe('m2');
  });

  test('response_format schemas are merged (union) and rightmost overrides duplicates', () => {
    const prompts = {
      t1: {
        prompt: 'First',
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 't1_out',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                A: { type: 'string' },
              },
              additionalProperties: false,
              required: ['A'],
            },
          },
        },
      },
      t2: {
        prompt: 'Second',
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 't2_out',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                B: { type: 'number' },
              },
              additionalProperties: false,
              required: ['B'],
            },
          },
        },
      },
    } as any;

    const res = composeTemplateChain(['t1','t2'], prompts);
    expect(res.response_format).toBeDefined();
    const props = res.response_format.json_schema.schema.properties;
    expect(props.A).toBeDefined();
    expect(props.B).toBeDefined();
    expect(res.response_format.json_schema.schema.required.sort()).toEqual(expect.arrayContaining(['A','B']));
  });

  test('duplicate nested fields: rightmost template overrides duplicate property definitions', () => {
    const prompts = {
      t1: {
        prompt: 'Outer',
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 't1',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                Shared: {
                  type: 'object',
                  properties: {
                    X: { type: 'string' },
                    Z: { type: 'string' }
                  },
                  required: ['X','Z'],
                },
                Top: { type: 'string' },
              },
              additionalProperties: false,
              required: ['Shared','Top'],
            },
          },
        },
      },
      t2: {
        prompt: 'Inner',
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 't2',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                Shared: {
                  type: 'object',
                  properties: {
                    X: { type: 'number' },
                    Y: { type: 'number' }
                  },
                  required: ['X','Y'],
                },
                Top: { type: 'string', enum: ['override'] },
              },
              additionalProperties: false,
              required: ['Shared'],
            },
          },
        },
      },
    } as any;

    const res = composeTemplateChain(['t1','t2'], prompts);
    const merged = res.response_format.json_schema.schema;

    // top-level properties union
    expect(merged.properties.Shared).toBeDefined();
    expect(merged.properties.Top).toBeDefined();

    // nested Shared properties: X should be overridden by t2, Z preserved from t1, Y added from t2
    expect(merged.properties.Shared.properties.X.type).toBe('number');
    expect(merged.properties.Shared.properties.Y.type).toBe('number');
    expect(merged.properties.Shared.properties.Z.type).toBe('string');

    // nested required follows rightmost definition for Shared (t2 required => X,Y)
    expect(merged.properties.Shared.required.sort()).toEqual(['X','Y']);

    // top-level required: Shared required was redefined by t2 (present), Top was present in t2 but not required there -> Top requirement should follow last-wins (t2 didn't include Top in required)
    expect(merged.required).toEqual(expect.arrayContaining(['Shared']));
    expect(merged.required).not.toEqual(expect.arrayContaining(['Top']));
  });
});

describe('buildJsonSchema', () => {
  test('builds nested schema', () => {
    const input = {
      A: { type: 'string' },
      B: { type: 'object', properties: { X: { type: 'string' } } }
    } as any;
    const out = buildJsonSchema(input);
    expect(out.B.properties.X.type).toBe('string');
  });
});
