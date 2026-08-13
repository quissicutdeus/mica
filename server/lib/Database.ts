export interface TransactionQuery {
  query: string;
  params?: any[];
}

export class Database {
  private static get oxmysql() {
    return (globalThis as any).exports?.oxmysql ?? (exports as any)?.oxmysql;
  }

  static async query<T = any>(query: string, params: any[] = []): Promise<T> {
    return await Database.oxmysql.query_async(query, params);
  }

  static async insert(query: string, params: any[] = []): Promise<number> {
    return await Database.oxmysql.insert_async(query, params);
  }

  static async update(query: string, params: any[] = []): Promise<boolean> {
    const result = await Database.oxmysql.update_async(query, params);
    return result > 0;
  }

  static async scalar<T = any>(query: string, params: any[] = []): Promise<T> {
    return await Database.oxmysql.scalar_async(query, params);
  }

  static async single<T = any>(query: string, params: any[] = []): Promise<T> {
    return await Database.oxmysql.single_async(query, params);
  }

  static async transaction(queries: TransactionQuery[]): Promise<boolean> {
    if (!queries || queries.length === 0) return true;
    const formatted = queries.map(({ query, params }) => ({ query, values: params ?? [] }));
    const result = await Database.oxmysql.transaction_async(formatted);
    return Boolean(result);
  }
}
