-- One row per player per fixture, typed and cleaned.
--   * 2019-20: the post-COVID gameweeks were published as rounds 39-47; they are gameweeks 30-38.
--   * Postponed fixtures leave a 0-minute placeholder row in the original round, and a few rows
--     are exact duplicates upstream; keep the latest row per (season, player, fixture).
--   * Seasons before 2020-21 have no per-row team, so the player's team is derived for every
--     season: a fixture's two clubs are the two distinct opponent ids seen in it. (Checked against
--     the published team on every 2020-21+ row; see tests/assert_derived_team_matches_published.sql.)
with typed as (
    select
        season,
        element::integer as fpl_element_id,
        fixture::integer as fpl_fixture_id,
        round::integer as source_round,
        case when season = '2019-20' and round::integer >= 39 then round::integer - 9 else round::integer end as gameweek,
        strptime(kickoff_time, '%Y-%m-%dT%H:%M:%SZ') as kickoff_at,
        was_home::boolean as was_home,
        opponent_team::integer as opponent_fpl_team_id,
        team_h_score::integer as home_goals,
        team_a_score::integer as away_goals,
        "minutes"::integer as minutes_played,
        starts::integer as starts,
        goals_scored::integer as goals,
        assists::integer as assists,
        clean_sheets::integer as clean_sheets,
        goals_conceded::integer as goals_conceded,
        own_goals::integer as own_goals,
        penalties_saved::integer as penalties_saved,
        penalties_missed::integer as penalties_missed,
        yellow_cards::integer as yellow_cards,
        red_cards::integer as red_cards,
        saves::integer as saves,
        bonus::integer as bonus_points,
        bps::integer as bps,
        total_points::integer as total_points,
        influence::double as influence,
        creativity::double as creativity,
        threat::double as threat,
        ict_index::double as ict_index,
        expected_goals::double as xg,
        expected_assists::double as xa,
        expected_goal_involvements::double as xgi,
        expected_goals_conceded::double as xgc,
        defensive_contribution::integer as defensive_contribution,
        value::integer / 10.0 as price,
        selected::bigint as selected_by,
        transfers_in::bigint as transfers_in,
        transfers_out::bigint as transfers_out
    from {{ ref('raw_gameweeks') }}
),

fixture_clubs as (
    select season, fpl_fixture_id,
           min(opponent_fpl_team_id) as club_a, max(opponent_fpl_team_id) as club_b
    from typed
    group by all
),

deduped as (
    select *
    from typed
    qualify row_number() over (
        partition by season, fpl_element_id, fpl_fixture_id
        order by kickoff_at desc, source_round desc
    ) = 1
)

select
    d.*,
    case when d.opponent_fpl_team_id = f.club_a then f.club_b else f.club_a end as fpl_team_id
from deduped d
join fixture_clubs f using (season, fpl_fixture_id)
