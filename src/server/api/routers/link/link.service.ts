import { waitUntil } from "@vercel/functions";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { parse } from "csv-parse/sync";
import { subDays } from "date-fns";
import { and, asc, count, desc, eq } from "drizzle-orm";

import { retrieveDeviceAndGeolocationData } from "@/lib/core/analytics";
import { Cache } from "@/lib/core/cache";
import { generateShortLink } from "@/lib/core/links";
import { fetchMetadataInfo } from "@/lib/utils/fetch-link-metadata";
import { db } from "@/server/db";
import { link, linkVisit, uniqueLinkVisit } from "@/server/db/schema";

import { logAnalytics } from "./utils";

import type { Link } from "@/server/db/schema";
import type { ProtectedTRPCContext, PublicTRPCContext } from "../../trpc";
import type {
  CreateLinkInput,
  GetLinkInput,
  ListLinksInput,
  QuickLinkShorteningInput,
  RetrieveOriginalUrlInput,
  UpdateLinkInput,
} from "./link.input";
const cache = new Cache();

function constructCacheKey(domain: string, alias: string) {
  return `${domain}:${alias}`;
}

export const getLinks = async (ctx: ProtectedTRPCContext, input: ListLinksInput) => {
  const { page, pageSize, orderBy, orderDirection } = input;

  const orderColumn = orderBy === "totalClicks" ? count(linkVisit.id) : link.createdAt;
  const orderFunc = orderDirection === "desc" ? desc : asc;

  const [totalLinksResult, totalClicksResult, links] = await Promise.all([
    ctx.db.select({ count: count() }).from(link).where(eq(link.userId, ctx.auth.userId)),
    ctx.db
      .select({ totalClicks: count(linkVisit.id) })
      .from(linkVisit)
      .innerJoin(link, eq(link.id, linkVisit.linkId))
      .where(eq(link.userId, ctx.auth.userId)),
    ctx.db
      .select({
        id: link.id,
        url: link.url,
        alias: link.alias,
        domain: link.domain,
        createdAt: link.createdAt,
        disableLinkAfterClicks: link.disableLinkAfterClicks,
        disableLinkAfterDate: link.disableLinkAfterDate,
        disabled: link.disabled,
        publicStats: link.publicStats,
        userId: link.userId,
        passwordHash: link.passwordHash,
        totalClicks: count(linkVisit.id).as("total_clicks"),
        note: link.note,
      })
      .from(link)
      .leftJoin(linkVisit, eq(link.id, linkVisit.linkId))
      .where(eq(link.userId, ctx.auth.userId))
      .groupBy(link.id)
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .orderBy(orderFunc(orderColumn)),
  ]);

  const totalLinks = totalLinksResult?.[0]?.count ?? 0;
  const totalClicks = totalClicksResult?.[0]?.totalClicks ?? 0;

  return {
    links,
    totalLinks,
    totalClicks,
    currentPage: page,
    totalPages: Math.ceil(totalLinks / pageSize),
  };
};

export const getLink = async (ctx: ProtectedTRPCContext, input: GetLinkInput) => {
  return ctx.db.query.link.findFirst({
    where: (table, { eq }) => eq(table.id, input.id),
  });
};

export const getLinkByAlias = async (input: { alias: string; domain: string }) => {
  return db
    .select()
    .from(link)
    .where(and(eq(link.domain, input.domain), eq(link.alias, input.alias)));
};

export const createLink = async (ctx: ProtectedTRPCContext, input: CreateLinkInput) => {
  const userSubscription = await ctx.db.query.subscription.findFirst({
    where: (table, { eq }) => eq(table.userId, ctx.auth.userId),
  });

  if (input.alias) {
    if (input.alias.includes(".")) {
      throw new Error("Cannot include periods in alias");
    }

    const domain = input.domain ?? "ishortn.ink";

    const aliasExists = await ctx.db
      .select()
      .from(link)
      .where(and(eq(link.alias, input.alias), eq(link.domain, domain)));

    if (aliasExists.length) {
      throw new Error("Alias already exists");
    }
  }

  if (input.password) {
    if (userSubscription?.status !== "active") {
      throw new Error("You need to upgrade to a pro plan to use password protection");
    }

    input.password = await bcrypt.hash(input.password, 10);
  }

  const domain = input.domain ?? "ishortn.ink";

  const inputMetaData = input.metadata;
  const metadataValues = Object.values(inputMetaData ?? {});
  const hasUserFilledMetadata = metadataValues.some(
    (value) => value !== undefined && value !== null && value !== "",
  );
  if (hasUserFilledMetadata) {
    if (userSubscription?.status !== "active") {
      throw new Error("You need to upgrade to a pro plan to use custom social media previews");
    }
  }

  const fetchedMetadata = await fetchMetadataInfo(input.url);

  input.metadata = {
    title: inputMetaData?.title ?? fetchedMetadata.title,
    description: inputMetaData?.description ?? fetchedMetadata.description,
    image: inputMetaData?.image ?? fetchedMetadata.image,
  };

  return ctx.db.insert(link).values({
    ...input,
    alias: input.alias ?? (await generateShortLink()),
    userId: ctx.auth.userId,
    passwordHash: input.password,
    domain,
    note: input.note,
    metadata: {
      ...input.metadata,
    },
  });
};

export const updateLink = async (ctx: ProtectedTRPCContext, input: UpdateLinkInput) => {
  await ctx.db
    .update(link)
    .set(input)
    .where(and(eq(link.id, input.id), eq(link.userId, ctx.auth.userId)));

  if (input.alias) {
    await cache.delete(input.alias);
  }

  const updatedLink = await ctx.db.query.link.findFirst({
    where: (table, { eq }) => eq(table.id, input.id),
  });

  await cache.set(constructCacheKey(updatedLink!.domain, updatedLink!.alias!), updatedLink!);
};

export const deleteLink = async (ctx: ProtectedTRPCContext, input: GetLinkInput) => {
  const linkToDelete = await ctx.db.query.link.findFirst({
    where: (table, { eq }) => eq(table.id, input.id),
  });

  if (!linkToDelete) {
    return null;
  }

  await cache.delete(constructCacheKey(linkToDelete.domain, linkToDelete.alias!));
  await ctx.db.delete(link).where(and(eq(link.id, input.id), eq(link.userId, ctx.auth.userId)));
};

export const retrieveOriginalUrl = async (
  ctx: PublicTRPCContext,
  input: RetrieveOriginalUrlInput,
) => {
  const { alias, domain } = input;
  const cacheKey = `${domain}:${alias}`;

  let link: Link | undefined | null = await cache.get(cacheKey);

  if (!link?.alias) {
    link = await ctx.db.query.link.findFirst({
      where: (table, { eq, and }) => and(eq(table.alias, input.alias), eq(table.domain, domain)),
    });

    if (!link) {
      return null;
    }
  }

  waitUntil(logAnalytics(ctx, link));

  return link;
};

export const shortenLinkWithAutoAlias = async (
  ctx: ProtectedTRPCContext,
  input: QuickLinkShorteningInput,
) => {
  const insertionResult = await ctx.db.insert(link).values({
    url: input.url,
    alias: await generateShortLink(),
    userId: ctx.auth.userId,
  });

  const insertedLinkId = insertionResult[0].insertId;

  const insertedLink = await ctx.db.query.link.findFirst({
    where: (table, { eq }) => eq(table.id, insertedLinkId),
  });

  if (insertedLink) {
    await cache.set(constructCacheKey(insertedLink.domain, insertedLink.alias!), insertedLink);
  }

  return insertedLink;
};

export const getLinkVisits = async (
  ctx: ProtectedTRPCContext,
  input: { id: string; domain: string },
) => {
  const userSubscription = await ctx.db.query.subscription.findFirst({
    where: (table, { eq }) => eq(table.userId, ctx.auth.userId),
  });
  const userHasProPlan = userSubscription?.status === "active";

  const sevenDaysAgo = subDays(new Date(), 7);

  const link = await ctx.db.query.link.findFirst({
    where: (table, { eq, and }) => and(eq(table.alias, input.id), eq(table.domain, input.domain)),
    with: {
      linkVisits: {
        where: userHasProPlan ? undefined : (visit, { gte }) => gte(visit.createdAt, sevenDaysAgo),
      },
      uniqueLinkVisits: {
        where: userHasProPlan ? undefined : (visit, { gte }) => gte(visit.createdAt, sevenDaysAgo),
      },
    },
  });

  if (!link || link?.linkVisits.length === 0) {
    return {
      totalVisits: [],
      uniqueVisits: [],
      topCountry: "N/A",
      referers: {},
      topReferrer: "N/A",
    };
  }

  const countryVisits = link.linkVisits.reduce(
    (acc, visit) => {
      acc[visit.country!] = (acc[visit.country!] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  const topCountry = Object.entries(countryVisits).reduce(
    (a, b) => (a[1] > b[1] ? a : b),
    ["", 0],
  )[0];

  const referrerVisits = link.linkVisits.reduce(
    (acc, visit) => {
      acc[visit.referer!] = (acc[visit.referer!] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  const topReferrer = Object.entries(referrerVisits).reduce(
    (a, b) => (a[1] > b[1] ? a : b),
    ["", 0],
  )[0];

  return {
    totalVisits: link.linkVisits,
    uniqueVisits: link.uniqueLinkVisits,
    topCountry,
    referers: referrerVisits,
    topReferrer: topReferrer !== "null" ? topReferrer : "Direct",
    isProPlan: userHasProPlan,
  };
};

export const togglePublicStats = async (ctx: ProtectedTRPCContext, input: GetLinkInput) => {
  const fetchedLink = await ctx.db.query.link.findFirst({
    where: (table, { eq }) => eq(table.id, input.id),
  });

  if (!fetchedLink) {
    return null;
  }

  return ctx.db
    .update(link)
    .set({
      publicStats: !fetchedLink.publicStats,
    })
    .where(and(eq(link.id, input.id), eq(link.userId, ctx.auth.userId)));
};

export const toggleLinkStatus = async (ctx: ProtectedTRPCContext, input: GetLinkInput) => {
  const fetchedLink = await ctx.db.query.link.findFirst({
    where: (table, { eq }) => eq(table.id, input.id),
  });

  if (!fetchedLink) {
    return null;
  }

  return ctx.db
    .update(link)
    .set({
      disabled: !fetchedLink.disabled,
    })
    .where(and(eq(link.id, input.id), eq(link.userId, ctx.auth.userId)));
};

export const resetLinkStatistics = async (ctx: ProtectedTRPCContext, input: GetLinkInput) => {
  const fetchedLink = await ctx.db.query.link.findFirst({
    where: (table, { eq }) => eq(table.id, input.id),
  });

  if (!fetchedLink) {
    return null;
  }

  await ctx.db.delete(linkVisit).where(eq(linkVisit.linkId, fetchedLink.id));

  return fetchedLink;
};

export const verifyLinkPassword = async (
  ctx: PublicTRPCContext,
  input: { id: number; password: string },
) => {
  const link = await ctx.db.query.link.findFirst({
    where: (table, { eq }) => eq(table.id, input.id),
  });

  if (!link?.passwordHash) {
    return null;
  }

  const isPasswordCorrect = await bcrypt.compare(input.password, link.passwordHash);

  if (!isPasswordCorrect) {
    return null;
  }

  const deviceDetails = await retrieveDeviceAndGeolocationData(ctx.headers);
  const ipHash = crypto
    .createHash("sha256")
    .update(ctx.headers.get("x-forwarded-for") ?? "")
    .digest("hex");
  const existingLinkVisit = await ctx.db.query.uniqueLinkVisit.findFirst({
    where: (table, { eq, and }) => and(eq(table.linkId, link.id), eq(table.ipHash, ipHash)),
  });

  if (!existingLinkVisit) {
    await ctx.db.insert(uniqueLinkVisit).values({
      linkId: link.id,
      ipHash,
    });
  }

  await ctx.db.insert(linkVisit).values({
    linkId: link.id,
    ...deviceDetails,
  });

  return link;
};

export const changeLinkPassword = async (
  ctx: ProtectedTRPCContext,
  input: { id: number; password: string },
) => {
  const passwordHash = await bcrypt.hash(input.password, 10);

  await ctx.db
    .update(link)
    .set({
      passwordHash,
    })
    .where(and(eq(link.id, input.id), eq(link.userId, ctx.auth.userId)));

  const updatedLink = await ctx.db.query.link.findFirst({
    where: (table, { eq }) => eq(table.id, input.id),
  });

  await cache.delete(constructCacheKey(updatedLink!.domain, updatedLink!.alias!));

  return updatedLink;
};

export const checkAliasAvailability = async (
  ctx: PublicTRPCContext,
  input: { alias: string; domain: string },
) => {
  const existingLink = await ctx.db.query.link.findFirst({
    where: (table, { eq, and }) =>
      and(eq(table.alias, input.alias), eq(table.domain, input.domain)),
  });

  return { isAvailable: !existingLink };
};

type LinkRecord = {
  url: string;
  alias?: string;
  domain?: string;
  note?: string;
};

export const bulkCreateLinks = async (ctx: ProtectedTRPCContext, csvContent: string) => {
  const records = parse(csvContent, { columns: true, skip_empty_lines: true }) as LinkRecord[];

  // we need to check for alias clashes and report those to the user, if we use promise.all, it will
  // fail if there is an alias clash so we need to use promise.allSettled
  // promise.all settled will return an array of objects with status and value, we can then filter out
  // the rejected promises and report those to the user
  const bulkLinksCreationPromiseResults = await Promise.allSettled(
    records.map(async (record: LinkRecord) => {
      const alias = record.alias ?? (await generateShortLink());
      await ctx.db.insert(link).values({
        url: record.url,
        alias,
        userId: ctx.auth.userId,
        domain: record.domain ?? "ishortn.ink",
        note: record.note,
      });
    }),
  );

  const successfulLinks = bulkLinksCreationPromiseResults.filter(
    (result) => result.status === "fulfilled",
  ).length;
  const failedLinks = bulkLinksCreationPromiseResults.filter(
    (result) => result.status === "rejected",
  ).length;

  // TODO: add a way to notify the user about links that failed. We have already added an email template.
  // so we need to filter the links that failed and attach the right reason to the email.

  return {
    success: true,
    message: `${successfulLinks} links created successfully, ${failedLinks} links failed to create`,
  };
};

export const exportAllUserLinks = async (ctx: ProtectedTRPCContext) => {
  return ctx.db.query.link.findMany({
    columns: {
      url: true,
      alias: true,
      note: true,
      domain: true,
      createdAt: true,
    },
    where: (table, { eq }) => eq(table.userId, ctx.auth.userId),
  });
};
