-- Daily calendar the semantic layer uses for time-based metrics.
select cast(range as date) as date_day
from range(date '2016-07-01', date '2027-07-01', interval 1 day)
