-- Repair v2 projections without changing raw payloads, timestamps, or tombstones.
UPDATE whoop_workouts SET
  zone_zero_milliseconds = CASE WHEN json_type(raw_json, '$.score.zone_durations.zone_zero_milli') IN ('integer', 'real')
    THEN json_extract(raw_json, '$.score.zone_durations.zone_zero_milli') ELSE zone_zero_milliseconds END,
  zone_one_milliseconds = CASE WHEN json_type(raw_json, '$.score.zone_durations.zone_one_milli') IN ('integer', 'real')
    THEN json_extract(raw_json, '$.score.zone_durations.zone_one_milli') ELSE zone_one_milliseconds END,
  zone_two_milliseconds = CASE WHEN json_type(raw_json, '$.score.zone_durations.zone_two_milli') IN ('integer', 'real')
    THEN json_extract(raw_json, '$.score.zone_durations.zone_two_milli') ELSE zone_two_milliseconds END,
  zone_three_milliseconds = CASE WHEN json_type(raw_json, '$.score.zone_durations.zone_three_milli') IN ('integer', 'real')
    THEN json_extract(raw_json, '$.score.zone_durations.zone_three_milli') ELSE zone_three_milliseconds END,
  zone_four_milliseconds = CASE WHEN json_type(raw_json, '$.score.zone_durations.zone_four_milli') IN ('integer', 'real')
    THEN json_extract(raw_json, '$.score.zone_durations.zone_four_milli') ELSE zone_four_milliseconds END,
  zone_five_milliseconds = CASE WHEN json_type(raw_json, '$.score.zone_durations.zone_five_milli') IN ('integer', 'real')
    THEN json_extract(raw_json, '$.score.zone_durations.zone_five_milli') ELSE zone_five_milliseconds END
WHERE json_valid(raw_json) AND score_state = 'SCORED'
  AND json_type(raw_json, '$.score.zone_durations') = 'object';
