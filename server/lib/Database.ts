const oxmysql = exports.oxmysql;

export class Database {
  static async query<T = any>(query: string, params: any[] = []): Promise<T> {
    return await oxmysql.query_async(query, params);
  }

  static async insert(query: string, params: any[] = []): Promise<number> {
    return await oxmysql.insert_async(query, params);
  }

  static async update(query: string, params: any[] = []): Promise<boolean> {
    const result = await oxmysql.update_async(query, params);
    return result > 0;
  }

  static async scalar<T = any>(query: string, params: any[] = []): Promise<T> {
    return await oxmysql.scalar_async(query, params);
  }

  static async single<T = any>(query: string, params: any[] = []): Promise<T> {
    return await oxmysql.single_async(query, params);
  }
}
