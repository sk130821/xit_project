import { getISTDateString, toISTDateString, daysBetweenYmd } from '../utils/istDate.js';

/**
 * ROI for one investment row: respects token_amount, total_return cap, and end_date (plan term).
 * After end_date, no further accrual; days in a period are capped at end_date.
 */
export function calculateInvestmentRoiAccrual(inv, asOfDate = null) {
  const today = asOfDate || getISTDateString();
  const lastRoi = toISTDateString(inv.last_roi_date);
  if (!lastRoi || lastRoi >= today) return null;

  const endDate = toISTDateString(inv.end_date);

  if (endDate && lastRoi >= endDate) {
    return {
      investmentId: inv.id,
      userId: inv.user_id,
      roi: 0,
      days: 0,
      completed: true,
      lastRoiDate: endDate,
    };
  }

  let accrualThrough = today;
  if (endDate && today > endDate) {
    accrualThrough = endDate;
  }

  const daysElapsed = daysBetweenYmd(lastRoi, accrualThrough);

  if (daysElapsed <= 0) {
    if (endDate && today >= endDate) {
      return {
        investmentId: inv.id,
        userId: inv.user_id,
        roi: 0,
        days: 0,
        completed: true,
        lastRoiDate: endDate,
      };
    }
    return null;
  }

  const dailyEarning = (Number(inv.token_amount) * Number(inv.daily_roi_rate)) / 100;
  let totalClaimable = dailyEarning * daysElapsed;

  const remaining = Number(inv.total_return) - Number(inv.roi_received);
  if (totalClaimable > remaining) totalClaimable = remaining;

  const completedByCap =
    Number(inv.roi_received) + totalClaimable >= Number(inv.total_return) - 1e-9;
  const completedByTime = Boolean(endDate && today >= endDate);

  const lastRoiDate = completedByTime ? endDate : today;

  if (totalClaimable <= 0) {
    return {
      investmentId: inv.id,
      userId: inv.user_id,
      roi: 0,
      days: daysElapsed,
      completed: completedByTime || completedByCap,
      lastRoiDate,
    };
  }

  return {
    investmentId: inv.id,
    userId: inv.user_id,
    roi: totalClaimable,
    days: daysElapsed,
    completed: completedByCap || completedByTime,
    lastRoiDate,
  };
}
