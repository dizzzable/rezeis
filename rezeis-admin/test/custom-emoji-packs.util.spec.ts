import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readCustomEmojiPacks } from '../src/modules/custom-emoji/utils/custom-emoji-packs.util';

describe('readCustomEmojiPacks', () => {
  it('keeps the Telegram source and builtin marker while normalizing a stored pack', () => {
    const packs = readCustomEmojiPacks({
      customEmojiPacks: [
        {
          id: 'news',
          name: 'News Emoji',
          setName: 'NewsEmoji',
          builtin: true,
          emojis: [
            {
              slug: 'news_1',
              imageUrl: '/uploads/emoji/news.webp',
              lottieUrl: null,
              videoUrl: '/uploads/emoji/news.webm',
              fallback: '📰',
              customEmojiId: '1001',
            },
          ],
        },
      ],
    });

    assert.deepStrictEqual(packs, [
      {
        id: 'news',
        name: 'News Emoji',
        setName: 'NewsEmoji',
        builtin: true,
        emojis: [
          {
            slug: 'news_1',
            name: 'news_1',
            imageUrl: '/uploads/emoji/news.webp',
            lottieUrl: null,
            videoUrl: '/uploads/emoji/news.webm',
            fallback: '📰',
            customEmojiId: '1001',
          },
        ],
      },
    ]);
  });
});
