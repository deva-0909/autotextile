-- The holiday calendar by office: national holidays apply everywhere, state ones only to the office in that state
-- (Surat: Gujarat 24, Kolkata: West Bengal 19, Tiruppur: Tamil Nadu 33). Dates for the demo; HR confirms each year's
-- list against the state government notification and edits it on the Holidays page.
INSERT INTO holidays (day, name, state_code) VALUES
 ('2026-01-14', 'Uttarayan (Makar Sankranti)', '24'),
 ('2026-01-15', 'Pongal', '33'),
 ('2026-01-23', 'Netaji Subhas Chandra Bose Jayanti', '19'),
 ('2026-01-26', 'Republic Day', NULL),
 ('2026-03-04', 'Holi', NULL),
 ('2026-04-14', 'Tamil New Year', '33'),
 ('2026-04-15', 'Bengali New Year (Poila Boishakh)', '19'),
 ('2026-05-01', 'Gujarat Day', '24'),
 ('2026-05-01', 'May Day', '33'),
 ('2026-10-19', 'Durga Puja (Maha Navami)', '19'),
 ('2026-10-20', 'Dussehra (Vijaya Dashami)', NULL),
 ('2026-11-10', 'Bhai Bij', '24'),
 ('2026-12-25', 'Christmas', NULL),
 ('2027-01-14', 'Uttarayan (Makar Sankranti)', '24'),
 ('2027-01-15', 'Pongal', '33')
ON CONFLICT (day, name) DO NOTHING;
