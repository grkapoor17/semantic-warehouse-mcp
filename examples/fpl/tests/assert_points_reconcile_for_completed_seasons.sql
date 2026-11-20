-- Summing fixtures must reproduce FPL's own season total for completed seasons
-- (the in-progress season can lag by a few points between snapshots, so it is excluded).
{{ config(severity = 'warn') }}
select ps.season, ps.player_code, ps.fpl_total_points, sum(pf.total_points) as summed
from {{ ref('dim_player_seasons') }} ps
join {{ ref('fct_player_fixtures') }} pf using (player_season_id)
where ps.season < '2026-27'
group by all
having sum(pf.total_points) <> ps.fpl_total_points
