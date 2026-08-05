import { SchemaRepository, type ResolvedService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { Blab } from '@shared/types';

/**
 * Author hydration for Blabber.
 *
 * `Blab.handle`, `display_name` and `avatar` are documented in `shared/types.ts` as "hydrated
 * for display", and `BlabRow`, `Thread` and `Profile` all render them — but nothing joined
 * `gphone_accounts`, so every feed in game rendered `@` with a silhouette and a blank name.
 * Only `create`'s echo carried a handle, which is why posting looked correct and reloading did
 * not. The browser mock embeds handles on every fixture, so `pnpm dev` and Playwright were both
 * green throughout: the bug was only ever visible against a real database.
 *
 * Batched per page rather than per row, exactly as `MessageRepository` batches attachments — a
 * feed of thirty posts is two queries, not sixty.
 *
 * The join **never selects `gphone_accounts.citizenid`**. `publicColumns` already withholds
 * Blabber's own, and re-adding the author's through a join would hand back the same
 * de-anonymisation vector by another route: a public read returns rows the reader does not own,
 * and with several accounts per player the owner's citizenid correlates two deliberately-separate
 * identities back to one person. The column list here is literal for that reason — there is no
 * `SELECT *` to widen by accident.
 */

/** What a reader is allowed to know about an author. No `citizenid`, ever. */
interface AuthorRow {
  id: number;
  handle: string;
  display_name: string | null;
  avatar: string | null;
}

const distinctIds = (values: (number | null | undefined)[]): number[] => [
  ...new Set(
    values
      .map((value) => Number(value))
      .filter((value): value is number => Number.isInteger(value) && value > 0)
  )
];

export class BlabberRepository extends SchemaRepository<Blab> {
  /**
   * Held because the mouthed-Blab read below is a second query against this same table and has
   * to narrow its projection the same way the generic public read does. `SchemaRepository` keeps
   * the allowlist but not this list, and reconstructing it here would be a second copy free to
   * drift from the declaration.
   */
  private readonly publicColumns: readonly string[];

  constructor(resolved: ResolvedService) {
    super(resolved);
    this.publicColumns = resolved.publicColumns;
  }

  async findAll(
    where: Partial<Blab> = {},
    page?: { limit?: number; cursor?: number },
    projection?: readonly string[]
  ): Promise<Blab[]> {
    return await this.hydrate(await super.findAll(where, page, projection));
  }

  /**
   * Attach each row's author, and the Blab it mouths.
   *
   * Public so `blabber:profile` can route its hand-built projection through the same code. The
   * two feeds must not be able to disagree about what an author looks like, and they did: the
   * profile action selected `publicColumns` and stopped there.
   *
   * One level of mouthing, deliberately. A quote of a quote renders its immediate target and no
   * further — `BlabRow` shows one nested card, so a deeper walk would fetch rows nothing paints,
   * and a chain of ten would be ten round trips for one row.
   */
  async hydrate(rows: Blab[]): Promise<Blab[]> {
    if (rows.length === 0) return rows;

    const mouthTargets = distinctIds(rows.map((row) => row.mouth_of));
    const mouthed = mouthTargets.length > 0 ? await this.selectPublic(mouthTargets) : [];

    // The page's authors and the quoted rows' authors in one read — a quote is usually somebody
    // else's, so splitting this would double the query count on any feed with mouths in it.
    const authors = await this.selectAuthors(
      distinctIds([...rows, ...mouthed].map((row) => row.account_id))
    );

    const mouthedById = new Map(
      mouthed.map((row) => [Number(row.id), this.attachAuthor(row, authors)])
    );

    for (const row of rows) {
      this.attachAuthor(row, authors);
      if (row.mouth_of != null) {
        // Null rather than undefined when the target is gone: a moderated or deleted Blab drops
        // out of `selectPublic`, and the row should say "Mouthed" with nothing quoted rather
        // than carry a stale card.
        row.mouthed = mouthedById.get(Number(row.mouth_of)) ?? null;
      }
    }

    return rows;
  }

  /**
   * One Blab as a public reader sees it, author included.
   *
   * For `create`'s echo of a mouth. The create handler has already read its target through
   * `findById`, which is `SELECT *` and therefore carries the author's `citizenid` — re-reading
   * through the public projection is cheaper than remembering to strip it, and it cannot be got
   * wrong later by somebody widening what the echo returns.
   */
  async findPublicById(id: number): Promise<Blab | null> {
    const [row] = await this.hydrate(await this.selectPublic([id]));
    return row ?? null;
  }

  /**
   * Rows from this table under the public projection.
   *
   * A plain query rather than `this.findAll`, so hydration cannot recurse into itself one
   * mouth at a time.
   */
  private async selectPublic(ids: number[]): Promise<Blab[]> {
    const projection = this.publicColumns.map((column) => `\`${column}\``).join(', ');
    const placeholders = ids.map(() => '?').join(', ');

    return await Database.query<Blab[]>(
      `SELECT ${projection} FROM \`${this.tableName}\`
       WHERE \`id\` IN (${placeholders}) AND \`status\` = 'active'`,
      ids
    );
  }

  /**
   * The display fields for a set of accounts.
   *
   * Not filtered by account `status`, and that is a decision rather than an oversight: nothing
   * writes `moderated` onto `gphone_accounts` yet, and filtering here would render a post from a
   * deleted account with a blank author — which is the exact bug this class exists to fix.
   * Moderating an account has to hide its *posts*, which is a cascade for the moderation phase,
   * not something a projection can stand in for.
   */
  private async selectAuthors(ids: number[]): Promise<Map<number, AuthorRow>> {
    if (ids.length === 0) return new Map();

    const placeholders = ids.map(() => '?').join(', ');
    const rows = await Database.query<AuthorRow[]>(
      `SELECT \`id\`, \`handle\`, \`display_name\`, \`avatar\` FROM \`gphone_accounts\`
       WHERE \`id\` IN (${placeholders})`,
      ids
    );

    return new Map(rows.map((row) => [Number(row.id), row]));
  }

  private attachAuthor(row: Blab, authors: Map<number, AuthorRow>): Blab {
    const author = authors.get(Number(row.account_id));
    if (!author) return row;

    row.handle = author.handle;
    row.display_name = author.display_name ?? null;
    row.avatar = author.avatar ?? null;
    return row;
  }
}
