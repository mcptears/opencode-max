import sqlite3

con = sqlite3.connect(r'file:E:/opencode-max/opencode-max/data/opencode-max.db?mode=ro', uri=True)
cur = con.cursor()
tables = [r[0] for r in cur.execute("select name from sqlite_master where type='table'")]
print('tables:', tables)
for t in tables:
    cols = [c[1] for c in cur.execute(f'pragma table_info({t})')]
    n = cur.execute(f'select count(*) from {t}').fetchone()[0]
    print(f'{t}: rows={n} cols={cols}')
con.close()
