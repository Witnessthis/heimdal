import type { FastifyPluginAsync } from 'fastify';
import { LANGUAGE_NAMES } from '../ai/language';
import { getSpokenLanguages, setSpokenLanguages } from '../lib/language-settings';
import { requireAuth } from '../lib/require-auth';

interface Options {
  dataDir: string;
}

export const settingsRoutes: FastifyPluginAsync<Options> = async (fastify, { dataDir }) => {
  fastify.addHook('onRequest', requireAuth);

  // `available` is included on every read rather than exposed as its own
  // endpoint — it's the same static ISO-639-1 list every time, but this
  // keeps the settings UI from needing a second round trip, and keeps
  // LANGUAGE_NAMES itself a backend-only concern (the frontend never
  // imports src/ai/* directly — see the Vite setup's shared-types-only
  // convention). Same list detectLanguage()'s own vocabulary is drawn
  // from, so anything selectable here is guaranteed comparable to
  // whatever the model ever actually detects.
  fastify.get('/languages', async (_request, reply) => {
    return reply.send({ selected: await getSpokenLanguages(dataDir), available: LANGUAGE_NAMES });
  });

  fastify.put<{ Body: { languages: string[] } }>(
    '/languages',
    {
      schema: {
        body: {
          type: 'object',
          required: ['languages'],
          properties: { languages: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      // Dedupe rather than reject a duplicate — the UI builds this list
      // from independent add actions, so a double-tap producing a repeat
      // entry is a harmless client-side accident, not a caller error
      // worth failing the whole request over.
      const languages = [...new Set(request.body.languages)];
      const invalid = languages.filter((l) => !LANGUAGE_NAMES.includes(l));
      if (invalid.length > 0) {
        return reply.code(400).send({ error: `Not a recognized language: ${invalid.join(', ')}` });
      }
      await setSpokenLanguages(dataDir, languages);
      return reply.send({ selected: languages });
    },
  );
};
