import { readAccessToken } from '@common/auth/tokens.ts';
import { DomainError } from '@common/errors/domain-error.ts';
import { ok } from '@common/interceptors/response-envelope.ts';
import { jsonOk } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { env } from '@config/env.ts';
import { db } from '@database/client.ts';
import {
  dailyFootprints,
  dailyLogs,
  lifestyleProfiles,
  userGardens,
  users,
} from '@database/schema/index.ts';
import { createRoute, z } from '@hono/zod-openapi';
import { desc, eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';

export const aiRoutes = createModule();

/** Optional auth middleware — extracts user claims if Authorization header is present */
const optionalUser: MiddlewareHandler = async (c, next) => {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const claims = await readAccessToken(token);
      if (claims) {
        c.set('user', {
          id: Number(claims.sub),
          role: claims.role,
          orgId: claims.org,
          orgRole: claims.orgRole,
        });
      }
    } catch {
      // Ignore token decode errors for optional auth
    }
  }
  await next();
};

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});

const chatRequestSchema = z.object({
  messages: z.array(messageSchema).min(1),
  context: z.record(z.string(), z.unknown()).optional(),
});

const chatResponseSchema = z.object({
  reply: z.string(),
});

const GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash',
  'gemini-3.8-flash',
];

function buildSystemInstruction(context: Record<string, any>): string {
  const parts: string[] = [
    `You are EcoLife AI — an encouraging, friendly, and expert sustainability coach inside the EcoLife platform.`,
    `Your goal is to help the user reduce their carbon footprint, adopt sustainable habits, explain their environmental metrics, suggest ways to earn EcoCoins, advise on tree planting, and guide their eco journey.`,
    `You have direct access to the user's live profile, baseline lifestyle data from their 15 onboarding questions, today's daily tracking logs, and virtual garden status.`,
    `Always refer to their specific numbers and answers naturally whenever relevant, but don't just dump raw data unless asked.`,
    `Keep your tone supportive, uplifting, practical, and scientifically accurate. Format your responses with clean markdown (bold highlights, bullet points, concise paragraphs).`,
  ];

  if (context.user) {
    const u = context.user;
    parts.push(
      `\n### USER PROFILE:\n` +
      `- Name: ${u.name || 'Friend'}\n` +
      `- Email: ${u.email || 'N/A'}\n` +
      `- EcoCoins Balance: ${u.coinsBalance ?? 0} coins (used in marketplace & garden)\n` +
      `- Lifetime Eco Points: ${u.pointsTotal ?? 0}\n` +
      `- Tracking Streak: ${u.streak ?? 0} days\n` +
      (u.rank ? `- Leaderboard Rank: #${u.rank}\n` : '') +
      (u.organization ? `- Organization: ${u.organization}\n` : '')
    );
  }

  if (context.onboarding) {
    const ob = context.onboarding;
    const a = (ob.answers || {}) as Record<string, any>;
    parts.push(
      `\n### 15 BASELINE LIFESTYLE QUESTIONS & ANSWERS:\n` +
      `1. Household Size: ${a.householdSize ?? 'Not specified'} people\n` +
      `2. City & Region: ${a.city || 'Not specified'} (${a.regionCode || 'N/A'})\n` +
      `3. Cooling Usage: ${a.coolingUsage || 'Not specified'}\n` +
      `4. Diet Type: ${a.dietType || 'Not specified'} (e.g. vegan, vegetarian, non-veg)\n` +
      `5. Food Waste Level: ${a.foodWasteLevel || 'Not specified'}\n` +
      `6. Packaged Food Frequency: ${a.packagedFoodFreq || 'Not specified'}\n` +
      `7. Primary Commute Mode: ${a.primaryCommuteMode || 'Not specified'}\n` +
      `8. Commute Distance (one-way): ${a.commuteDistanceKm ? `${a.commuteDistanceKm} km` : 'Not specified'}\n` +
      `9. Vehicle Fuel Type: ${a.vehicleFuel || 'Not specified'}\n` +
      `10. Flights Per Year: ${a.flightsPerYear ?? 'Not specified'}\n` +
      `11. Monthly Electricity Consumption: ${a.electricityKwhMonth ? `${a.electricityKwhMonth} kWh` : 'Not specified'}\n` +
      `12. Electricity Bill: ${a.electricityBillInr ? `₹${a.electricityBillInr}` : 'Not specified'}\n` +
      `13. Cooking Fuel: ${a.cookingFuel || 'Not specified'}\n` +
      `14. Rooftop Solar: ${a.hasSolar ? 'Yes' : 'No'}\n` +
      `15. Water & Waste Habits: Water level ${a.waterUsageLevel || 'medium'}, Waste habit: ${a.wasteHabit || 'Not specified'}\n` +
      (ob.baseline?.totalKg ? `- Baseline Carbon Footprint: ${Number(ob.baseline.totalKg).toFixed(1)} kg CO2/day\n` : '')
    );
  }

  if (context.dailyTrack) {
    const dt = context.dailyTrack;
    const da = dt.answers;
    parts.push(
      `\n### TODAY'S DAILY TRACKING & LOGS:\n` +
      `- Date: ${dt.date || 'Today'}\n` +
      `- Logged Today: ${dt.logged ? 'Yes' : 'Not yet logged'}\n` +
      (dt.todayKg !== undefined ? `- Today's Carbon Footprint: ${Number(dt.todayKg).toFixed(2)} kg CO2 (Baseline: ${Number(dt.baselineTotalKg || 0).toFixed(2)} kg)\n` : '') +
      (dt.deltaKg !== undefined ? `- Carbon Delta: ${dt.deltaKg < 0 ? `${Math.abs(dt.deltaKg).toFixed(2)} kg saved!` : `+${Number(dt.deltaKg).toFixed(2)} kg over baseline`}\n` : '') +
      (dt.reductionPct !== undefined ? `- Footprint Change: ${Number(dt.reductionPct).toFixed(1)}%\n` : '') +
      (da ? (
        `- Daily Travel: ${da.trips && Array.isArray(da.trips) && da.trips.length > 0 ? da.trips.map((t: any) => `${t.mode} (${t.km} km)`).join(', ') : 'No trips logged'}\n` +
        `- Daily Meals: ${da.vegMeals ?? 0} veg, ${da.veganMeals ?? 0} vegan, ${da.nonVegMeals ?? 0} non-veg\n` +
        `- AC Usage: ${da.acHoursBucket ?? '0'} hours\n` +
        `- Bathing Choice: ${da.bathChoice ?? 'Not specified'}\n` +
        `- Waste Actions: ${da.wasteActions && Array.isArray(da.wasteActions) && da.wasteActions.length > 0 ? da.wasteActions.join(', ') : 'None'}\n`
      ) : '')
    );
  }

  if (context.garden) {
    const g = context.garden;
    parts.push(
      `\n### VIRTUAL GARDEN:\n` +
      `- Garden Biome: ${g.biome || 'Meadow'}\n` +
      `- Character Skin: ${g.characterSkin || 'Gardener'}\n` +
      `- Trees Planted: ${g.treesCount ?? 0}\n` +
      `- Pets in Garden: ${g.petsCount ?? 0}\n`
    );
  }

  return parts.join('\n');
}

aiRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/chat',
    tags: ['ai'],
    summary: 'AI Advisor Chatbot powered by Google Gemini',
    middleware: [optionalUser] as const,
    request: {
      body: {
        content: {
          'application/json': {
            schema: chatRequestSchema,
          },
        },
      },
    },
    responses: {
      200: jsonOk(chatResponseSchema, 'AI response generated successfully'),
    },
  }),
  async (c) => {
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new DomainError('AI_KEY_MISSING', 'Gemini API key is not configured on the server.', 500);
    }

    const body = c.req.valid('json');
    const { messages, context: clientContext = {} } = body;

    // Collect DB-backed context if user is signed in
    const mergedContext: Record<string, any> = { ...clientContext };
    const authUser = c.get('user');

    if (authUser?.id) {
      try {
        const [userRow] = await db.select().from(users).where(eq(users.id, authUser.id)).limit(1);
        if (userRow) {
          mergedContext.user = {
            name: userRow.name,
            email: userRow.email,
            coinsBalance: userRow.coinsBalance,
            pointsTotal: userRow.pointsTotal,
            streak: userRow.currentStreak,
            ...mergedContext.user,
          };
        }

        const [lpRow] = await db
          .select()
          .from(lifestyleProfiles)
          .where(eq(lifestyleProfiles.userId, authUser.id))
          .limit(1);
        if (lpRow) {
          mergedContext.onboarding = {
            completed: lpRow.completedSteps === 5,
            answers: {
              householdSize: lpRow.householdSize,
              city: lpRow.city,
              regionCode: lpRow.regionCode,
              coolingUsage: lpRow.coolingUsage,
              dietType: lpRow.dietType,
              foodWasteLevel: lpRow.foodWasteLevel,
              packagedFoodFreq: lpRow.packagedFoodFreq,
              primaryCommuteMode: lpRow.primaryCommuteMode,
              vehicleFuel: lpRow.vehicleFuel,
              commuteDistanceKm: lpRow.commuteDistanceKm,
              flightsPerYear: lpRow.flightsPerYear,
              electricityKwhMonth: lpRow.electricityKwhMonth,
              electricityBillInr: lpRow.electricityBillInr,
              cookingFuel: lpRow.cookingFuel,
              hasSolar: lpRow.hasSolar,
              waterUsageLevel: lpRow.waterUsageLevel,
              wasteHabit: lpRow.wasteHabit,
            },
            baseline: {
              totalKg: lpRow.baselineTotalKg,
              transportKg: lpRow.baselineTransportKg,
              foodKg: lpRow.baselineFoodKg,
              homeEnergyKg: lpRow.baselineHomeEnergyKg,
              wasteKg: lpRow.baselineWasteKg,
              waterKg: lpRow.baselineWaterKg,
            },
            ...mergedContext.onboarding,
          };
        }

        // Daily track
        const [dailyLog] = await db
          .select()
          .from(dailyLogs)
          .where(eq(dailyLogs.userId, authUser.id))
          .orderBy(desc(dailyLogs.logDate))
          .limit(1);
        const [dailyFootprint] = await db
          .select()
          .from(dailyFootprints)
          .where(eq(dailyFootprints.userId, authUser.id))
          .orderBy(desc(dailyFootprints.logDate))
          .limit(1);

        if (dailyLog || dailyFootprint) {
          mergedContext.dailyTrack = {
            date: dailyLog?.logDate ? new Date(dailyLog.logDate).toISOString().split('T')[0] : 'Today',
            logged: !!dailyLog,
            todayKg: dailyFootprint?.totalKg,
            baselineTotalKg: dailyFootprint?.baselineTotalKg,
            deltaKg: dailyFootprint ? dailyFootprint.totalKg - dailyFootprint.baselineTotalKg : 0,
            reductionPct: dailyFootprint?.reductionPct,
            answers: dailyLog
              ? {
                  trips: dailyLog.trips,
                  vegMeals: dailyLog.vegMeals,
                  nonVegMeals: dailyLog.nonVegMeals,
                  veganMeals: dailyLog.veganMeals,
                  acHoursBucket: dailyLog.acHoursBucket,
                  bathChoice: dailyLog.bathChoice,
                  wasteActions: dailyLog.wasteActions,
                }
              : undefined,
            ...mergedContext.dailyTrack,
          };
        }

        // Virtual garden
        const [gardenRow] = await db
          .select()
          .from(userGardens)
          .where(eq(userGardens.userId, authUser.id))
          .limit(1);
        if (gardenRow && gardenRow.gardenState) {
          const gs = gardenRow.gardenState as any;
          mergedContext.garden = {
            biome: gs.activeBiomeId,
            characterSkin: gs.activeSkinId,
            treesCount: gs.plantedTrees?.length || 0,
            petsCount: gs.activePetIds?.length || 0,
            ...mergedContext.garden,
          };
        }
      } catch (err) {
        console.warn('[AI Routes] Could not fetch DB context:', err);
      }
    }

    // Memory: up to 5 previous turns (up to 10 previous messages + current)
    const trimmed = messages.slice(-11);
    const contents = trimmed.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    while (contents.length > 0 && contents[0]?.role !== 'user') {
      contents.shift();
    }

    if (contents.length === 0) {
      throw new DomainError('AI_INVALID_MESSAGES', 'At least one valid user message is required.', 400);
    }

    const systemInstruction = buildSystemInstruction(mergedContext);

    let replyText = '';
    let lastError: Error | null = null;

    for (const model of GEMINI_MODELS) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents,
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 1000,
            },
          }),
        });

        if (!res.ok) {
          const errData = (await res.json().catch(() => ({}))) as any;
          throw new Error(errData?.error?.message || `Gemini status ${res.status}`);
        }

        const data = (await res.json()) as any;
        replyText =
          data?.candidates?.[0]?.content?.parts?.[0]?.text ||
          'I am sorry, but I could not formulate a response. Please try again.';
        break;
      } catch (err: any) {
        lastError = err;
        console.warn(`[AI Route] Model ${model} failed, trying next:`, err?.message);
      }
    }

    if (!replyText) {
      throw new DomainError('AI_GENERATION_FAILED', lastError?.message || 'Failed to generate response.', 502);
    }

    return ok(c, { reply: replyText });
  }
);
