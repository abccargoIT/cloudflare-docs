-- Sample data for LOCAL TESTING ONLY.
--
-- None of these people, companies or shipments are real. The references follow
-- ABC Cargo's shape so the screens read correctly, but every value here is
-- invented. This file must never be run against a production database.

DELETE FROM activities;
DELETE FROM calls;
DELETE FROM tickets;
DELETE FROM booking_milestones;
DELETE FROM bookings;
DELETE FROM quotations;
DELETE FROM leads;
DELETE FROM customers;
DELETE FROM companies;

UPDATE ref_sequences SET next_value = 1;

INSERT INTO companies (id, name, region_id, account_type, credit_terms, created_at, updated_at) VALUES
	('co_1', 'Marzooqi Trading LLC', 'uae', 'trade', '30 days', '2019-04-01T00:00:00Z', '2019-04-01T00:00:00Z'),
	('co_2', 'Harbi Garments Est.',  'ksa', 'trade', '15 days', '2022-02-01T00:00:00Z', '2022-02-01T00:00:00Z');

INSERT INTO customers (id, company_id, display_name, wa_id, phone, email, region_id, account_type, opt_in_marketing, created_at, updated_at) VALUES
	('cus_971506621184', 'co_1', 'Rashid Al Marzooqi', '971506621184', '+971 50 662 1184', 'rashid@example.invalid', 'uae', 'trade', 1, '2019-04-01T00:00:00Z', '2026-09-15T05:00:00Z'),
	('cus_966507742201', 'co_2', 'Abdulaziz Al Harbi', '966507742201', '+966 50 774 2201', 'aziz@example.invalid',   'ksa', 'trade', 1, '2022-02-01T00:00:00Z', '2026-09-15T05:00:00Z'),
	('cus_447700900214', NULL,   'Daniel Okoye',       '447700900214', '+44 7700 900 214', 'd.okoye@example.invalid','uk',  'cash',  0, '2026-01-10T00:00:00Z', '2026-09-15T05:00:00Z');

-- A shipment the customer can ask about by reference.
INSERT INTO bookings (id, ref, quotation_id, customer_id, region_id, origin, destination, mode, pieces, weight_kg, value_amount, currency, milestone, milestone_at, created_at, updated_at) VALUES
	('bkg_1', 'ABC-UAE-088210', NULL, 'cus_971506621184', 'uae', 'Dubai', 'Kochi', 'air', 3, 41, 3180, 'AED', 'departed', '2026-09-12T17:40:00Z', '2026-09-10T08:00:00Z', '2026-09-12T17:40:00Z'),
	('bkg_2', 'ABC-KSA-030488', NULL, 'cus_966507742201', 'ksa', 'Jeddah', 'Karachi', 'air', 5, 96, 5640, 'SAR', 'delivered', '2026-09-13T11:20:00Z', '2026-09-08T08:00:00Z', '2026-09-13T11:20:00Z');

INSERT INTO booking_milestones (booking_id, milestone, occurred_at, source, created_at) VALUES
	('bkg_1', 'booked',    '2026-09-10T08:00:00Z', 'api', '2026-09-10T08:00:00Z'),
	('bkg_1', 'collected', '2026-09-11T09:30:00Z', 'shipment_system', '2026-09-11T09:30:00Z'),
	('bkg_1', 'departed',  '2026-09-12T17:40:00Z', 'shipment_system', '2026-09-12T17:40:00Z'),
	('bkg_2', 'booked',    '2026-09-08T08:00:00Z', 'api', '2026-09-08T08:00:00Z'),
	('bkg_2', 'delivered', '2026-09-13T11:20:00Z', 'shipment_system', '2026-09-13T11:20:00Z');

INSERT INTO activities (customer_id, region_id, kind, ref, summary, detail, actor, occurred_at, created_at) VALUES
	('cus_971506621184', 'uae', 'booking',   'ABC-UAE-088210', 'Booking ABC-UAE-088210 created', 'Dubai to Kochi, air, 3 pcs, 41 kg', 'system', '2026-09-10T08:00:00Z', '2026-09-10T08:00:00Z'),
	('cus_971506621184', 'uae', 'milestone', 'ABC-UAE-088210', 'ABC-UAE-088210 — departed', 'Dubai to Kochi', 'shipment_system', '2026-09-12T17:40:00Z', '2026-09-12T17:40:00Z'),
	('cus_966507742201', 'ksa', 'milestone', 'ABC-KSA-030488', 'ABC-KSA-030488 — delivered', 'Jeddah to Karachi', 'shipment_system', '2026-09-13T11:20:00Z', '2026-09-13T11:20:00Z');
