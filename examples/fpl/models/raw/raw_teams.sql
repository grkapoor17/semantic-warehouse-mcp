-- Team names by season. teams.csv exists from 2019-20; master_team_list.csv covers 2016-17..2023-24.
select
    regexp_extract(filename, '(\d{4}-\d{2})', 1) as season,
    id as team,
    name as team_name,
    short_name,
    'teams.csv' as source_file
from read_csv('{{ var("raw_dir") }}/20*/teams.csv', header = true, union_by_name = true, filename = true)
union all
select season, team, team_name, null as short_name, 'master_team_list.csv' as source_file
from read_csv('{{ var("raw_dir") }}/master_team_list.csv', header = true)
where season < '2019-20'
