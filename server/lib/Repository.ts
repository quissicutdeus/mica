import { Database } from './Database';

export abstract class Repository<T> {
  protected abstract tableName: string;

  async create(data: Partial<T>): Promise<number> {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map(() => '?').join(', ');
    const query = `INSERT INTO ${this.tableName} (${keys.join(', ')}) VALUES (${placeholders})`;
    return await Database.insert(query, values);
  }

  async findById(id: number | string): Promise<T | null> {
    const query = `SELECT * FROM ${this.tableName} WHERE id = ?`;
    return await Database.single<T>(query, [id]);
  }

  async findAll(where: Partial<T> = {}): Promise<T[]> {
    let query = `SELECT * FROM ${this.tableName}`;
    const filterWhere = { ...where };
    if (!('status' in filterWhere)) {
      (filterWhere as any).status = 'active';
    }

    const keys = Object.keys(filterWhere);
    const values = Object.values(filterWhere);

    if (keys.length > 0) {
      const conditions = keys.map((key) => `${key} = ?`).join(' AND ');
      query += ` WHERE ${conditions}`;
    }

    return await Database.query<T[]>(query, values);
  }

  async update(id: number | string, data: Partial<T>): Promise<boolean> {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const setClause = keys.map((key) => `${key} = ?`).join(', ');
    const query = `UPDATE ${this.tableName} SET ${setClause} WHERE id = ?`;
    return await Database.update(query, [...values, id]);
  }

  async delete(id: number | string): Promise<boolean> {
    const query = `UPDATE ${this.tableName} SET status = 'deleted' WHERE id = ?`;
    return await Database.update(query, [id]);
  }
}
