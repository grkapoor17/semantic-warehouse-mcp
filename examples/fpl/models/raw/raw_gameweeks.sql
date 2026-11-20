-- One row per player per fixture, exactly as published, for every season.
-- 2016-17..2018-19 files are Latin-1; later seasons are UTF-8. Columns drift by season, so union by name.
-- kickoff_time is read as text so the warehouse never depends on time-zone (ICU) support at query time.
select
    regexp_extract(filename, '(\d{4}-\d{2})', 1) as season,
    * exclude (filename)
from read_csv(
    '{{ var("raw_dir") }}/201[678]-*/gws/merged_gw.csv',
    encoding = 'latin-1', header = true, union_by_name = true, filename = true,
    types = {'kickoff_time': 'VARCHAR'}
)
union all by name
select
    regexp_extract(filename, '(\d{4}-\d{2})', 1) as season,
    * exclude (filename)
from read_csv(
    ['{{ var("raw_dir") }}/2019-20/gws/merged_gw.csv', '{{ var("raw_dir") }}/202*/gws/merged_gw.csv'],
    header = true, union_by_name = true, filename = true,
    types = {'kickoff_time': 'VARCHAR'}
)
