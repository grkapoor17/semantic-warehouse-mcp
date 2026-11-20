-- From 2020-21 the source publishes each row's team name. Our derived team must match it on every row.
select pf.season, pf.fpl_element_id, pf.fpl_fixture_id, t.team_name as derived, g.team as published
from {{ ref('stg_player_fixtures') }} pf
join {{ ref('stg_teams') }} t on t.season = pf.season and t.fpl_team_id = pf.fpl_team_id
join {{ ref('raw_gameweeks') }} g
  on g.season = pf.season and g.element::integer = pf.fpl_element_id and g.fixture::integer = pf.fpl_fixture_id
where g.team is not null and g.team <> t.team_name
