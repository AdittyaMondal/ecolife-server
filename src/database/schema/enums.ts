import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Postgres enums (PRD-v2 §7.1).
 *
 * Declarations stay literal and one value per line: both client repos mirror
 * this file by parsing it (PRD-v2 §9.4), so a clever refactor here silently
 * breaks their codegen.
 */

/**
 * Partner organizations. The platform labels in the UI are
 * Corporate / Community / Marketplace Partners respectively, and each maps to
 * one portal — but those are copy and routing, not data, so they live in the
 * clients.
 */
export const organizationType = pgEnum('organization_type', ['industry', 'ngo', 'seller']);

/**
 * An organization is NOT usable until an admin approves it. Anyone can claim
 * to be a corporate partner at signup; nobody gets a portal that can list
 * products or host official drives until a human says so.
 */
export const organizationStatus = pgEnum('organization_status', [
  'pending',
  'approved',
  'rejected',
  'suspended',
]);

/** A person's role inside their organization. Not a global identity. */
export const orgMemberRole = pgEnum('org_member_role', ['owner', 'member']);

export const userRole = pgEnum('user_role', ['user', 'admin']);

export const dietType = pgEnum('diet_type', [
  'vegan',
  'vegetarian',
  'eggetarian',
  'non_veg_weekly',
  'non_veg_daily',
]);

export const level3 = pgEnum('level3', ['low', 'medium', 'high']);

export const freq3 = pgEnum('freq3', ['rarely', 'sometimes', 'often']);

export const coolingUsage = pgEnum('cooling_usage', [
  'none',
  'fan_only',
  'ac_occasional',
  'ac_daily',
]);

export const commuteMode = pgEnum('commute_mode', [
  'walk',
  'cycle',
  'bus',
  'metro_train',
  'two_wheeler',
  'car',
  'cab',
  'auto_rickshaw',
  'work_from_home',
]);

export const vehicleFuel = pgEnum('vehicle_fuel', [
  'petrol',
  'diesel',
  'cng',
  'electric',
  'not_applicable',
]);

export const cookingFuel = pgEnum('cooking_fuel', ['lpg', 'png', 'electric_induction', 'firewood']);

export const wasteHabit = pgEnum('waste_habit', [
  'segregate_and_compost',
  'segregate_only',
  'none',
]);

export const bathChoice = pgEnum('bath_choice', ['bucket', 'short_shower', 'long_shower']);

export const kwhSource = pgEnum('kwh_source', ['reported', 'from_bill', 'estimated']);

export const acHoursBucket = pgEnum('ac_hours_bucket', ['0', '1_3', '4_8', '8_plus']);

export const emissionCategory = pgEnum('emission_category', [
  'transport',
  'food',
  'home_energy',
  'water',
  'waste',
]);

export const goalType = pgEnum('goal_type', ['reduce_percent', 'absolute_cap']);

export const goalPeriod = pgEnum('goal_period', ['week', 'month', 'quarter']);

export const goalStatus = pgEnum('goal_status', ['active', 'achieved', 'missed', 'cancelled']);

export const rewardSource = pgEnum('reward_source', [
  'onboarding',
  'daily_log',
  'streak',
  'reduction',
  'goal',
  'event_attend',
  'event_host',
  'order',
  'order_refund',
  'admin',
]);

export const eventType = pgEnum('event_type', [
  'plant_drive',
  'cleanup_drive',
  'awareness',
  'recycling_drive',
  'workshop',
  'other',
]);

export const eventStatus = pgEnum('event_status', [
  'draft',
  'published',
  'ongoing',
  'completed',
  'cancelled',
]);

export const eventVisibility = pgEnum('event_visibility', [
  'public',
  'invite_only',
  'organization_only',
]);

export const eventRole = pgEnum('event_role', ['host', 'co_host']);

export const passStatus = pgEnum('pass_status', [
  'registered',
  'checked_in',
  'cancelled',
  'no_show',
]);

export const productCategory = pgEnum('product_category', [
  'plants',
  'household',
  'personal_care',
  'kitchen',
  'stationery',
]);

export const discountType = pgEnum('discount_type', ['none', 'percentage', 'fixed']);

export const orderStatus = pgEnum('order_status', [
  'placed',
  'confirmed',
  'shipped',
  'delivered',
  'cancelled',
]);

export const settlementStatus = pgEnum('settlement_status', [
  'pending',
  'settled',
  'cancelled',
]);

export const settlementTransactionType = pgEnum('settlement_transaction_type', [
  'sale_commission',
  'coin_subsidy',
  'coin_fee',
  'seller_payout',
]);

export const payoutStatus = pgEnum('payout_status', [
  'pending',
  'processing',
  'completed',
  'failed',
]);

