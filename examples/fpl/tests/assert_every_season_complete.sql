-- A missing or truncated source file must fail the build, not quietly shrink the warehouse.
-- (2026-11-27: four seasons' files vanished locally and every other test still passed.)
-- Every completed season has 380 matches; the pinned 2026-27 snapshot has 60 (gameweeks 1-6).
with expected as (
    select season, case when season = '2026-27' then 60 else 380 end as matches
    from (select unnest(['2016-17','2017-18','2018-19','2019-20','2020-21','2021-22',
                         '2022-23','2023-24','2024-25','2025-26','2026-27']) as season)
),
actual as (
    select season, count(*) as matches from {{ ref('fct_fixtures') }} group by season
)
select e.season, e.matches as expected, coalesce(a.matches, 0) as actual
from expected e left join actual a using (season)
where coalesce(a.matches, 0) <> e.matches
