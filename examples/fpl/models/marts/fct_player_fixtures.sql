with pf as (
    select * from {{ ref('stg_player_fixtures') }}
),
players as (
    select season, fpl_element_id, player_code, position from {{ ref('stg_players') }}
),
teams as (
    select s.season, s.fpl_team_id, s.team_code, d.team_name
    from {{ ref('stg_teams') }} s
    join {{ ref('dim_teams') }} d using (team_code)
)
select
    pf.season || '-' || pf.fpl_fixture_id || '-' || p.player_code as player_fixture_id,
    pf.season || '-' || p.player_code as player_season_id,
    pf.season || '-' || pf.fpl_fixture_id as fixture_id,
    pf.season,
    cast(left(pf.season, 4) as integer) as season_start_year,
    pf.gameweek,
    pf.kickoff_at,
    cast(pf.kickoff_at as date) as kickoff_date,
    p.player_code,
    p.position,
    t.team_code,
    t.team_name,
    o.team_code as opponent_team_code,
    o.team_name as opponent_team_name,
    pf.was_home,
    case when pf.was_home then pf.home_goals else pf.away_goals end as team_goals,
    case when pf.was_home then pf.away_goals else pf.home_goals end as opponent_goals,
    case
        when pf.home_goals is null or pf.away_goals is null then null
        when pf.home_goals = pf.away_goals then 'D'
        when (pf.home_goals > pf.away_goals) = pf.was_home then 'W'
        else 'L'
    end as result,
    pf.minutes_played,
    pf.minutes_played > 0 as appeared,
    pf.starts,
    pf.goals,
    pf.assists,
    pf.clean_sheets,
    pf.goals_conceded,
    pf.own_goals,
    pf.penalties_saved,
    pf.penalties_missed,
    pf.yellow_cards,
    pf.red_cards,
    pf.saves,
    pf.bonus_points,
    pf.bps,
    pf.total_points,
    pf.influence,
    pf.creativity,
    pf.threat,
    pf.ict_index,
    pf.xg,
    pf.xa,
    pf.xgi,
    pf.xgc,
    pf.defensive_contribution,
    pf.price,
    pf.selected_by,
    pf.transfers_in,
    pf.transfers_out
from pf
join players p on p.season = pf.season and p.fpl_element_id = pf.fpl_element_id
join teams t on t.season = pf.season and t.fpl_team_id = pf.fpl_team_id
join teams o on o.season = pf.season and o.fpl_team_id = pf.opponent_fpl_team_id
