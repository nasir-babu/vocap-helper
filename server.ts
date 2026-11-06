import express, { type Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProd = process.env.NODE_ENV === 'production';
const isVercel = process.env.VERCEL === '1';
const PORT = Number(process.env.PORT) || 3000;

// Local fallback store file if PostgreSQL is not yet configured by user
const FALLBACK_STORE_FILE = path.join(__dirname, 'server-words-store.json');

export interface WordItem {
  id: string;
  word: string;
  meaning: string;
  pos?: string | null;
  sentence?: string | null;
  sentenceBn?: string | null;
  mode: string;
  status: 'new' | 'revision' | 'done';
  createdAt: string;
}

export interface WordCardData {
  id: string;
  title?: string | null;
  status: 'new' | 'revision' | 'done';
  createdAt: string;
  updatedAt: string;
  words: WordItem[];
}

// Convert Bengali numerals (০-৯) to Western digits (0-9)
export function normalizeDigits(str: string): string {
  const bnToEn: Record<string, string> = {
    '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
    '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9'
  };
  return str.replace(/[০-৯]/g, m => bnToEn[m] || m);
}

// Helper to check if a card's date matches a search query like "10-12", "10-12-26", "10-12-2026"
export function matchesDateQuery(createdAtStr: string, query: string): boolean {
  if (!query) return false;
  const cleanQ = normalizeDigits(query.trim().toLowerCase());

  const d = new Date(createdAtStr);
  if (isNaN(d.getTime())) return false;

  const cardDay = d.getDate(); // 1-31
  const cardMonth = d.getMonth() + 1; // 1-12
  const cardYearFull = d.getFullYear(); // 2026
  const cardYearShort = cardYearFull % 100; // 26

  // Check formats: DD-MM, DD-MM-YY, DD-MM-YYYY, or with slash/dot
  const dateMatch = cleanQ.match(/^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?$/);
  if (dateMatch) {
    const qDay = parseInt(dateMatch[1], 10);
    const qMonth = parseInt(dateMatch[2], 10);
    const qYear = dateMatch[3] ? parseInt(dateMatch[3], 10) : null;

    if (qDay === cardDay && qMonth === cardMonth) {
      if (qYear === null) return true;
      if (qYear === cardYearShort || qYear === cardYearFull) return true;
    }
  }

  // Also check direct string inclusions
  const pad = (n: number) => String(n).padStart(2, '0');
  const d1 = `${pad(cardDay)}-${pad(cardMonth)}-${cardYearFull}`;
  const d2 = `${pad(cardDay)}-${pad(cardMonth)}-${pad(cardYearShort)}`;
  const d3 = `${pad(cardDay)}-${pad(cardMonth)}`;
  const d4 = `${cardDay}-${cardMonth}-${cardYearShort}`;
  const d5 = `${cardDay}-${cardMonth}`;

  if (d1.includes(cleanQ) || d2.includes(cleanQ) || d3.includes(cleanQ) || d4.includes(cleanQ) || d5.includes(cleanQ)) {
    return true;
  }

  return false;
}

// Fallback file storage management
function readFallbackCards(): WordCardData[] {
  if (!fs.existsSync(FALLBACK_STORE_FILE)) {
    return [];
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(FALLBACK_STORE_FILE, 'utf-8'));
  if (!Array.isArray(parsed)) {
    throw new Error('Fallback word store must contain a JSON array.');
  }

  if (parsed.length === 0 || (parsed[0] && Array.isArray(parsed[0].words))) {
    return parsed as WordCardData[];
  }

  const legacyWords = parsed as any[];
  const now = new Date().toISOString();
  const migratedCard: WordCardData = {
    id: 'card_migrated_' + Date.now(),
    title: 'Imported Words Batch',
    status: 'new',
    createdAt: legacyWords[0]?.createdAt || now,
    updatedAt: now,
    words: legacyWords.map(w => ({
      id: w.id || 'w_' + Math.random().toString(36).substr(2, 8),
      word: w.word,
      meaning: w.meaning,
      pos: w.pos || null,
      sentence: w.sentence || null,
      sentenceBn: w.sentenceBn || null,
      mode: w.mode || 'en-to-bn',
      status: w.status || 'new',
      createdAt: w.createdAt || now
    }))
  };
  writeFallbackCards([migratedCard]);
  return [migratedCard];
}

function writeFallbackCards(cards: WordCardData[]) {
  fs.writeFileSync(FALLBACK_STORE_FILE, JSON.stringify(cards, null, 2), 'utf-8');
}

// Compute statistics strictly over individual words & unique words across cards
function computeCardsStats(cards: WordCardData[]) {
  let totalWords = 0;
  let newWords = 0;
  let revisionWords = 0;
  let doneWords = 0;
  const uniqueSet = new Set<string>();

  for (const card of cards) {
    const cardWords = card.words || [];
    const count = cardWords.length;
    totalWords += count;

    if (card.status === 'revision') {
      revisionWords += count;
    } else if (card.status === 'done') {
      doneWords += count;
    } else {
      newWords += count;
    }

    for (const w of cardWords) {
      if (w.word) {
        uniqueSet.add(w.word.trim().toLowerCase());
      }
    }
  }

  return {
    totalWords,
    uniqueWords: uniqueSet.size,
    newWords,
    revisionWords,
    doneWords,
    totalCards: cards.length,
    newCards: cards.filter(c => c.status === 'new').length,
    revisionCards: cards.filter(c => c.status === 'revision').length,
    doneCards: cards.filter(c => c.status === 'done').length
  };
}

class DatabaseUnavailableError extends Error {}

const databaseUrl = process.env.DATABASE_URL?.trim() || '';
const isDatabaseUrlConfigured = databaseUrl.length > 0;
const hasValidDbUrl = (() => {
  try {
    const url = new URL(databaseUrl);
    return ['postgres:', 'postgresql:'].includes(url.protocol);
  } catch {
    return false;
  }
})();
const canUseLocalFallback = !isProd && !isVercel && !isDatabaseUrlConfigured;

let prisma: PrismaClient | null = null;
let prismaConnection: Promise<PrismaClient> | null = null;
let isPrismaConnected = false;
let dbStatusMessage = !isDatabaseUrlConfigured
  ? 'DATABASE_URL is not configured.'
  : hasValidDbUrl
    ? 'PostgreSQL connection has not been checked yet.'
    : 'DATABASE_URL must be a valid PostgreSQL connection URL.';

async function getPrismaClient(): Promise<PrismaClient | null> {
  if (!hasValidDbUrl) {
    return null;
  }

  const client = prisma ?? (prisma = new PrismaClient());
  if (!prismaConnection) {
    prismaConnection = client.$connect()
      .then(() => {
        isPrismaConnected = true;
        dbStatusMessage = 'Connected to PostgreSQL via Prisma.';
        return client;
      })
      .catch(() => {
        isPrismaConnected = false;
        dbStatusMessage = 'PostgreSQL connection failed. Check DATABASE_URL, network access, and SSL settings.';
        prismaConnection = null;
        throw new DatabaseUnavailableError(dbStatusMessage);
      });
  }

  return prismaConnection;
}

async function getAllCardsFromDbOrFallback(): Promise<WordCardData[]> {
  const client = await getPrismaClient();
  if (client) {
    const dbCards = await client.wordCard.findMany({
      include: {
        words: {
          orderBy: { createdAt: 'asc' }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    return dbCards.map(c => ({
      id: c.id,
      title: c.title,
      status: (c.status as 'new' | 'revision' | 'done') || 'new',
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      words: c.words.map(w => ({
        id: w.id,
        word: w.word,
        meaning: w.meaning,
        pos: w.pos,
        sentence: w.sentence,
        sentenceBn: w.sentenceBn,
        mode: w.mode,
        status: (w.status as 'new' | 'revision' | 'done') || (c.status as any) || 'new',
        createdAt: w.createdAt.toISOString()
      }))
    }));
  }

  if (canUseLocalFallback) {
    return readFallbackCards();
  }

  throw new DatabaseUnavailableError(
    isDatabaseUrlConfigured
      ? 'DATABASE_URL is not a valid PostgreSQL URL.'
      : 'Set DATABASE_URL to a persistent PostgreSQL database before using the API.'
  );
}

function sendApiError(res: Response, error: unknown, message: string) {
  const isDatabaseFailure = error instanceof DatabaseUnavailableError || isDatabaseUrlConfigured || isProd;
  if (isDatabaseFailure) {
    const publicMessage = error instanceof DatabaseUnavailableError
      ? error.message
      : 'PostgreSQL request failed. Check DATABASE_URL and run bun run prisma:push.';
    console.error(`${message} PostgreSQL request failed.`);
    return res.status(503).json({ success: false, error: publicMessage });
  }

  console.error(message, error);
  return res.status(500).json({
    success: false,
    error: error instanceof Error ? error.message : message
  });
}

export async function createServer() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ================= API ROUTES =================

  // 1. Health & Database Status
  app.get('/api/status', async (_req, res) => {
    try {
      const allCards = await getAllCardsFromDbOrFallback();
      res.json({
        success: true,
        connected: isPrismaConnected,
        provider: isPrismaConnected ? 'postgresql' : 'local-fallback',
        databaseUrlConfigured: isDatabaseUrlConfigured,
        statusMessage: dbStatusMessage,
        stats: computeCardsStats(allCards)
      });
    } catch (error) {
      sendApiError(res, error, 'Error checking database status:');
    }
  });

  // 2. GET Cards with Search (Text & Date), Status, and Time Range Filter
  app.get(['/api/cards', '/api/words'], async (req, res) => {
    try {
      const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
      const statusFilter = typeof req.query.status === 'string' ? req.query.status.trim() : 'all';
      const timeRange = typeof req.query.timeRange === 'string' ? req.query.timeRange.trim() : 'all';
      const dateFilter = typeof req.query.date === 'string' ? req.query.date.trim() : '';

      const allCards = await getAllCardsFromDbOrFallback();
      const stats = computeCardsStats(allCards);

      const now = Date.now();
      let filtered = allCards;

      // Filter by Card Status (all | new | revision | done | unique)
      if (statusFilter && statusFilter !== 'all' && statusFilter !== 'unique') {
        filtered = filtered.filter(c => c.status === statusFilter);
      }

      // Filter by Time Range (Requirement 2: লাস্ট ৩ দিন, লাস্ট সপ্তাহ, লাস্ট মাস, লাস্ট বছর)
      if (timeRange && timeRange !== 'all') {
        filtered = filtered.filter(c => {
          const cardTime = new Date(c.createdAt).getTime();
          if (isNaN(cardTime)) return true;
          const diffMs = now - cardTime;

          if (timeRange === 'last-3-days') {
            return diffMs <= 3 * 24 * 60 * 60 * 1000;
          } else if (timeRange === 'last-week') {
            return diffMs <= 7 * 24 * 60 * 60 * 1000;
          } else if (timeRange === 'last-month') {
            return diffMs <= 30 * 24 * 60 * 60 * 1000;
          } else if (timeRange === 'last-year') {
            return diffMs <= 365 * 24 * 60 * 60 * 1000;
          }
          return true;
        });
      }

      // Filter by specific Date (YYYY-MM-DD)
      if (dateFilter) {
        filtered = filtered.filter(c => {
          const cDate = c.createdAt ? c.createdAt.split('T')[0] : '';
          return cDate === dateFilter;
        });
      }

      // Filter by Search Query: Text or Date format (Requirement 1: 10-12, 10-12-26, etc.)
      if (search) {
        filtered = filtered.filter(card => {
          // 1. Check if query matches date format (e.g. 10-12 or 10-12-26 or 10-12-2026 or বাংলা সংখ্যা)
          if (matchesDateQuery(card.createdAt, search)) {
            return true;
          }

          // 2. Check if query matches card title
          if (card.title && card.title.toLowerCase().includes(search)) {
            return true;
          }

          // 3. Check if query matches ANY word, meaning, pos, or sentence inside this card
          return (card.words || []).some(w => {
            return (
              w.word.toLowerCase().includes(search) ||
              w.meaning.toLowerCase().includes(search) ||
              (w.pos && w.pos.toLowerCase().includes(search)) ||
              (w.sentence && w.sentence.toLowerCase().includes(search)) ||
              (w.sentenceBn && w.sentenceBn.toLowerCase().includes(search))
            );
          });
        });
      }

      res.json({
        success: true,
        count: filtered.length,
        stats,
        cards: filtered
      });
    } catch (error) {
      sendApiError(res, error, 'Error fetching cards:');
    }
  });

  // 3. POST Save Words as a SINGLE BATCH CARD (Requirement 3)
  app.post(['/api/cards', '/api/words'], async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const incomingList: any[] = Array.isArray(body.words) ? body.words : (body.words ? [body.words] : [body]);

      if (!incomingList || incomingList.length === 0) {
        return res.status(400).json({ success: false, error: 'No words provided' });
      }

      const cleanItems = incomingList.filter(item => item && item.word && item.meaning).map(item => ({
        word: String(item.word).trim(),
        meaning: String(item.meaning).trim(),
        pos: item.pos ? String(item.pos).trim() : null,
        sentence: item.sentence ? String(item.sentence).trim() : null,
        sentenceBn: item.sentenceBn ? String(item.sentenceBn).trim() : null,
        mode: item.mode ? String(item.mode).trim() : 'en-to-bn',
        status: (['new', 'revision', 'done'].includes(item.status) ? item.status : 'new') as 'new' | 'revision' | 'done'
      }));

      if (cleanItems.length === 0) {
        return res.status(400).json({ success: false, error: 'Valid word and meaning are required' });
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const cardTitle = body.title || `Learning Session (${cleanItems.length} Words)`;

      let createdCard: WordCardData | null = null;

      const client = await getPrismaClient();
      if (client) {
        const dbCard = await client.wordCard.create({
          data: {
            title: cardTitle,
            status: 'new',
            words: {
              create: cleanItems.map(item => ({
                word: item.word,
                meaning: item.meaning,
                pos: item.pos || null,
                sentence: item.sentence || null,
                sentenceBn: item.sentenceBn || null,
                mode: item.mode || 'en-to-bn',
                status: 'new'
              }))
            }
          },
          include: {
            words: true
          }
        });

        createdCard = {
          id: dbCard.id,
          title: dbCard.title,
          status: 'new',
          createdAt: dbCard.createdAt.toISOString(),
          updatedAt: dbCard.updatedAt.toISOString(),
          words: dbCard.words.map(w => ({
            id: w.id,
            word: w.word,
            meaning: w.meaning,
            pos: w.pos,
            sentence: w.sentence,
            sentenceBn: w.sentenceBn,
            mode: w.mode,
            status: 'new',
            createdAt: w.createdAt.toISOString()
          }))
        };
      }

      // Fallback store if Prisma not available
      if (!createdCard) {
        if (!canUseLocalFallback) {
          throw new DatabaseUnavailableError(
            'PostgreSQL is required here. Configure DATABASE_URL before saving data.'
          );
        }

        const store = readFallbackCards();
        createdCard = {
          id: 'card_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
          title: cardTitle,
          status: 'new',
          createdAt: nowIso,
          updatedAt: nowIso,
          words: cleanItems.map((item, idx) => ({
            id: 'w_' + Date.now() + '_' + idx + '_' + Math.random().toString(36).substr(2, 4),
            word: item.word,
            meaning: item.meaning,
            pos: item.pos || null,
            sentence: item.sentence || null,
            sentenceBn: item.sentenceBn || null,
            mode: item.mode || 'en-to-bn',
            status: 'new',
            createdAt: nowIso
          }))
        };
        store.unshift(createdCard);
        writeFallbackCards(store);
      }

      const allCards = await getAllCardsFromDbOrFallback();
      const stats = computeCardsStats(allCards);

      res.status(201).json({
        success: true,
        message: `Successfully saved ${cleanItems.length} words into 1 new card`,
        card: createdCard,
        savedCount: cleanItems.length,
        stats
      });
    } catch (error) {
      sendApiError(res, error, 'Error saving card batch:');
    }
  });

  // 4. PATCH Update entire Card Status (Requirement 4: sets status for all words in this card)
  app.patch('/api/cards/:id/status', async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      if (!['new', 'revision', 'done'].includes(status)) {
        return res.status(400).json({ success: false, error: 'Status must be new, revision, or done' });
      }

      const client = await getPrismaClient();
      if (client) {
        const freshCard = await client.$transaction(async transaction => {
          await transaction.wordCard.update({
            where: { id },
            data: { status }
          });

          await transaction.word.updateMany({
            where: { cardId: id },
            data: { status }
          });

          return transaction.wordCard.findUnique({
            where: { id },
            include: { words: true }
          });
        });

        if (!freshCard) {
          return res.status(404).json({ success: false, error: 'Card not found' });
        }

        const allCards = await getAllCardsFromDbOrFallback();
        const stats = computeCardsStats(allCards);

        return res.json({
          success: true,
          card: freshCard,
          stats
        });
      }

      if (!canUseLocalFallback) {
        throw new DatabaseUnavailableError(
          'PostgreSQL is required here. Configure DATABASE_URL before updating data.'
        );
      }

      const store = readFallbackCards();
      const target = store.find(c => c.id === id);
      if (!target) {
        return res.status(404).json({ success: false, error: 'Card not found' });
      }

      target.status = status;
      target.updatedAt = new Date().toISOString();
      // Set all words inside this card to the same status
      target.words.forEach(w => {
        w.status = status;
      });

      writeFallbackCards(store);
      const stats = computeCardsStats(store);

      res.json({
        success: true,
        card: target,
        stats
      });
    } catch (error) {
      sendApiError(res, error, 'Error updating card status:');
    }
  });

  // 5. DELETE entire Card
  app.delete('/api/cards/:id', async (req, res) => {
    try {
      const { id } = req.params;

      const client = await getPrismaClient();
      if (client) {
        const result = await client.wordCard.deleteMany({ where: { id } });
        if (result.count === 0) {
          return res.status(404).json({ success: false, error: 'Card not found' });
        }

        const allCards = await getAllCardsFromDbOrFallback();
        return res.json({
          success: true,
          message: 'Card deleted from database',
          stats: computeCardsStats(allCards)
        });
      }

      if (!canUseLocalFallback) {
        throw new DatabaseUnavailableError(
          'PostgreSQL is required here. Configure DATABASE_URL before deleting data.'
        );
      }

      const store = readFallbackCards();
      const filtered = store.filter(c => c.id !== id);
      if (filtered.length === store.length) {
        return res.status(404).json({ success: false, error: 'Card not found' });
      }
      writeFallbackCards(filtered);

      res.json({
        success: true,
        message: 'Card deleted successfully',
        stats: computeCardsStats(filtered)
      });
    } catch (error) {
      sendApiError(res, error, 'Error deleting card:');
    }
  });

  // 6. DELETE single word from inside a Card
  app.delete('/api/cards/:cardId/words/:wordId', async (req, res) => {
    try {
      const { cardId, wordId } = req.params;

      const client = await getPrismaClient();
      if (client) {
        const deleted = await client.$transaction(async transaction => {
          const result = await transaction.word.deleteMany({
            where: { id: wordId, cardId }
          });
          if (result.count === 0) {
            return false;
          }

          const remainingWords = await transaction.word.count({ where: { cardId } });
          if (remainingWords === 0) {
            await transaction.wordCard.deleteMany({ where: { id: cardId } });
          }
          return true;
        });

        if (!deleted) {
          return res.status(404).json({ success: false, error: 'Word not found in card' });
        }

        const allCards = await getAllCardsFromDbOrFallback();
        return res.json({
          success: true,
          message: 'Word removed from card',
          stats: computeCardsStats(allCards)
        });
      }

      if (!canUseLocalFallback) {
        throw new DatabaseUnavailableError(
          'PostgreSQL is required here. Configure DATABASE_URL before deleting data.'
        );
      }

      const store = readFallbackCards();
      const card = store.find(c => c.id === cardId);
      if (card) {
        card.words = card.words.filter(w => w.id !== wordId);
        if (card.words.length === 0) {
          const remainingCards = store.filter(c => c.id !== cardId);
          writeFallbackCards(remainingCards);
          return res.json({ success: true, message: 'Empty card removed', stats: computeCardsStats(remainingCards) });
        } else {
          writeFallbackCards(store);
          return res.json({ success: true, message: 'Word removed', stats: computeCardsStats(store) });
        }
      }

      res.status(404).json({ success: false, error: 'Card not found' });
    } catch (error) {
      sendApiError(res, error, 'Error removing word:');
    }
  });

  // 7. DELETE Clear all Cards
  app.delete(['/api/cards', '/api/words'], async (_req, res) => {
    try {
      const client = await getPrismaClient();
      if (client) {
        await client.$transaction([
          client.word.deleteMany({}),
          client.wordCard.deleteMany({})
        ]);
        return res.json({
          success: true,
          message: 'All cards and words deleted from database',
          stats: computeCardsStats([])
        });
      }

      if (!canUseLocalFallback) {
        throw new DatabaseUnavailableError(
          'PostgreSQL is required here. Configure DATABASE_URL before clearing data.'
        );
      }

      writeFallbackCards([]);
      res.json({
        success: true,
        message: 'All cards cleared from server',
        stats: computeCardsStats([])
      });
    } catch (error) {
      sendApiError(res, error, 'Error clearing cards:');
    }
  });

  // ================= VITE OR STATIC SERVING =================
  if (!isProd && !isVercel) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, host: '0.0.0.0', port: PORT },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else if (!isVercel) {
    const distPath = path.join(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    } else {
      app.use(express.static(__dirname));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(__dirname, 'index.html'));
      });
    }
  }

  return app;
}

if (
  !isVercel &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === __filename
) {
  createServer()
    .then(app => {
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`VocabCraft server listening on http://0.0.0.0:${PORT}`);
      });
    })
    .catch(() => {
      console.error('Critical server startup failure.');
      process.exitCode = 1;
    });
}
