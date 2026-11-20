-- One row per Premier League match, built from the player rows so it covers every season.
with home_rows as (
    select *
    from {{ ref('fct_player_fixtures') }}
    where was_home
    qualify row_number() over (partition by fixture_id order by kickoff_at desc) = 1
)
select
    fixture_id,
    season,
    season_start_year,
    gameweek,
    kickoff_at,
    kickoff_date,
    team_code as home_team_code,
    opponent_team_code as away_team_code,
    team_goals as home_goals,
    opponent_goals as away_goals
from home_rows
