import { Prisma } from "@prisma/client";

/** Treat model/issue-like alphanumeric tokens as literal constraints, not topics.
 * Numeric dates and ordinary hyphenated words are not identifiers. */
export function searchIdentifiers(query: string): string[] {
  return [
    ...new Set(
      (query.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? []).filter(
        (token) => /\p{L}/u.test(token) && /\p{N}/u.test(token),
      ),
    ),
  ];
}

/** All SQL expressions come from fixed adapter columns, never caller SQL. */
export function identifierPredicate(query: string, text: Prisma.Sql) {
  const identifiers = searchIdentifiers(query);
  return identifiers.length
    ? Prisma.join(
        identifiers.map(
          (token) =>
            Prisma.sql`${text} ~* ${`(^|[^[:alnum:]_-])${token}($|[^[:alnum:]_-])`}`,
        ),
        " AND ",
      )
    : Prisma.sql`true`;
}

export function lexicalQueries(query: string) {
  return Prisma.sql`search_query AS (
    SELECT plainto_tsquery('simple',${query}) AS simple,
      plainto_tsquery('english',${query}) AS english,
      plainto_tsquery('russian',${query}) AS russian
  )`;
}

export function lexicalDocuments(
  title: Prisma.Sql,
  text: Prisma.Sql,
  summary = Prisma.sql`''`,
  body = text,
) {
  return Prisma.sql`to_tsvector('simple',${text}) AS document,
    to_tsvector('simple',${title}) AS simple_title,
    to_tsvector('english',${title}) AS english_title,
    to_tsvector('russian',${title}) AS russian_title,
    setweight(to_tsvector('english',${title}),'A') || setweight(to_tsvector('english',${summary}),'B') || setweight(to_tsvector('english',${body}),'D') AS english_document,
    setweight(to_tsvector('russian',${title}),'A') || setweight(to_tsvector('russian',${summary}),'B') || setweight(to_tsvector('russian',${body}),'D') AS russian_document`;
}

/** Complete-query evidence gets a hybrid fusion vote. Partial OR candidates
 * remain retrievable; provider degradation gives every lexical candidate a vote. */
export function lexicalMatch(query: string, text: Prisma.Sql, hybrid: boolean) {
  const q = (config: "simple" | "english" | "russian") =>
    hybrid
      ? Prisma.sql`q.${Prisma.raw(config)}`
      : Prisma.sql`to_tsquery(${config}::regconfig,replace(q.${Prisma.raw(config)}::text,' & ',' | '))`;
  return Prisma.sql`(document @@ ${q("simple")} OR english_document @@ ${q("english")} OR russian_document @@ ${q("russian")}
    OR strpos(lower(${text}),lower(${query}))>0)`;
}

export const lexicalScore = Prisma.sql`greatest(
  ts_rank(english_document,q.english,32),ts_rank(russian_document,q.russian,32))`;

/** A single token can be a keyword lookup; questions and phrases stay hybrid. */
export const keywordLookup = (query: string) =>
  /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(query.trim());

export const titleMatch = Prisma.sql`(
  simple_title @@ q.simple OR english_title @@ q.english OR russian_title @@ q.russian)`;

/** Semantic expansion of a title-backed keyword must be at least as close as
 * the weakest indexed title match. No anchor means no extra restriction. */
export function keywordAnchor(
  query: string,
  documents: "filtered" | "documents",
  maxDistance: number,
) {
  return Prisma.sql`keyword_anchor AS (
    SELECT max(d.distance)::float8 AS "distanceLimit"
    FROM distances d JOIN ${Prisma.raw(documents)} f ON f.id=d.id CROSS JOIN search_query q
    WHERE ${keywordLookup(query)} AND d.distance < ${maxDistance} AND ${titleMatch}
  )`;
}

export const keywordAdmission = Prisma.sql`(
  a."distanceLimit" IS NULL OR d.distance<=a."distanceLimit"
  OR EXISTS(SELECT 1 FROM lexical l WHERE l.id=d.id AND l.vote))`;
