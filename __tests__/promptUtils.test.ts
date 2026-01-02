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
