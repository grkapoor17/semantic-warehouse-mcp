-- One row per club per season, keyed by FPL's per-season team id, resolved to the stable team_code.
with codes as (
    select distinct season, team::int as fpl_team_id, team_code::int as team_code
    from {{ ref('raw_players') }}
)
select
    c.season,
    c.fpl_team_id,
    c.team_code,
    t.team_name,
    t.short_name
from codes c
left join {{ ref('raw_teams') }} t
    on t.season = c.season and t.team::int = c.fpl_team_id
