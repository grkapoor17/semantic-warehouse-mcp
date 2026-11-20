-- One row per player per season (FPL's end-of-season / latest snapshot of each player).
select
    regexp_extract(filename, '(\d{4}-\d{2})', 1) as season,
    * exclude (filename)
from read_csv('{{ var("raw_dir") }}/*/players_raw.csv', header = true, union_by_name = true, filename = true)
