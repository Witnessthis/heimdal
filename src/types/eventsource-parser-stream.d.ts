// eventsource-parser's "./stream" subpath export has no "types" condition in
// its package.json exports map, so it's invisible to classic Node module
// resolution (this build's tsconfig.json, deliberately kept on CommonJS +
// "Node" resolution — see that file's own comment on why). The real .d.ts
// exists at node_modules/eventsource-parser/dist/stream.d.ts; this mirrors
// it exactly rather than declaring the module as untyped `any`. Pulled in
// transitively via @ai-sdk/provider-utils (src/ai/model.ts).
declare module 'eventsource-parser/stream' {
  export type ErrorType = 'invalid-retry' | 'unknown-field' | 'max-buffer-size-exceeded';

  export interface EventSourceMessage {
    event?: string | undefined;
    id?: string | undefined;
    data: string;
  }

  export interface StreamOptions {
    onError?: ('terminate' | ((error: Error) => void)) | undefined;
    onRetry?: ((retry: number) => void) | undefined;
    onComment?: ((comment: string) => void) | undefined;
    maxBufferSize?: number | undefined;
  }

  export class EventSourceParserStream extends TransformStream<string, EventSourceMessage> {
    constructor(options?: StreamOptions);
  }

  export class ParseError extends Error {
    type: ErrorType;
    field?: string | undefined;
    value?: string | undefined;
    line?: string | undefined;
    constructor(message: string, options: { type: ErrorType; field?: string; value?: string; line?: string });
  }
}
