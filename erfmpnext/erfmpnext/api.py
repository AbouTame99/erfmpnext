# Copyright (c) 2025, Your Company and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.utils import nowdate, getdate, add_days, now_datetime, flt


def get_score_from_thresholds(value, thresholds, reverse=False):
    """
    Get score 1-5 based on value and thresholds.
    thresholds = list of 4 values for scores 5 down to 2
    If reverse=True, higher value = higher score (for frequency/monetary)
    If reverse=False, lower value = higher score (for recency/payment)
    """
    if reverse:
        # Higher value = higher score (frequency, monetary)
        for i, threshold in enumerate(thresholds):
            if value >= threshold:
                return 5 - i
        return 1
    else:
        # Lower value = higher score (recency, payment days late)
        for i, threshold in enumerate(thresholds):
            if value <= threshold:
                return 5 - i
        return 1


def get_payment_terms_days(customer):
    """Get credit days from customer's default payment terms template"""
    payment_terms = frappe.db.get_value("Customer", customer, "payment_terms")
    if not payment_terms:
        return 0
    
    # Get the first row's credit days from the payment terms template
    credit_days = frappe.db.get_value(
        "Payment Terms Template Detail",
        {"parent": payment_terms},
        "credit_days"
    )
    return credit_days or 0


@frappe.whitelist()
def calculate_rfm_scores():
    """Calculate RFMP scores for all customers based on Sales Invoices"""
    settings = frappe.get_single("RFM Settings")
    today = getdate(nowdate())
    period_start = add_days(today, -settings.analysis_period_days or -365)
    
    # Build threshold lists from settings (Only 4 thresholds needed for 1-5 scale)
    recency_thresholds = [
        settings.recency_days_5 or 30,
        settings.recency_days_4 or 60,
        settings.recency_days_3 or 90,
        settings.recency_days_2 or 180,
    ]
    
    frequency_thresholds = [
        settings.frequency_orders_5 or 10,
        settings.frequency_orders_4 or 5,
        settings.frequency_orders_3 or 3,
        settings.frequency_orders_2 or 2,
    ]
    
    monetary_thresholds = [
        flt(settings.monetary_amount_5) or 50000,
        flt(settings.monetary_amount_4) or 25000,
        flt(settings.monetary_amount_3) or 10000,
        flt(settings.monetary_amount_2) or 2000,
    ]
    
    payment_thresholds = [
        settings.payment_days_5 if settings.payment_days_5 is not None else -7,
        settings.payment_days_4 if settings.payment_days_4 is not None else 7,
        settings.payment_days_3 if settings.payment_days_3 is not None else 30,
        settings.payment_days_2 if settings.payment_days_2 is not None else 60,
    ]
    
    # Get all customers with their invoice data
    customer_data = frappe.db.sql("""
        SELECT 
            c.name as customer,
            c.customer_name,
            MAX(si.posting_date) as last_purchase_date,
            COUNT(DISTINCT si.name) as total_orders,
            SUM(si.grand_total) as total_spent
        FROM `tabCustomer` c
        LEFT JOIN `tabSales Invoice` si ON si.customer = c.name 
            AND si.docstatus = 1 
        GROUP BY c.name, c.customer_name
    """, as_dict=True)
    
    results = {"processed": 0, "alerts_created": 0}
    
    for cust in customer_data:
        # Calculate days since last purchase
        if cust.last_purchase_date:
            days_since = (today - getdate(cust.last_purchase_date)).days
        else:
            days_since = 9999  # Never purchased
        
        # Calculate R score
        r_score = get_score_from_thresholds(days_since, recency_thresholds, reverse=False)
        
        # Calculate F score
        f_score = get_score_from_thresholds(cust.total_orders or 0, frequency_thresholds, reverse=True)
        
        # Calculate M score
        m_score = get_score_from_thresholds(flt(cust.total_spent) or 0, monetary_thresholds, reverse=True)
        
        # Calculate Payment score
        payment_data = calculate_payment_score_per_invoice(cust.customer, payment_thresholds)
        p_score = payment_data['p_score']
        
        # Calculate totals
        total_score = r_score + f_score + m_score + p_score
        average_score = round(total_score / 4, 1)
        
        # Get or create Customer RFM Score record
        existing = frappe.db.exists("Customer RFM Score", cust.customer)
        
        if existing:
            doc = frappe.get_doc("Customer RFM Score", cust.customer)
            old_average = doc.average_score or 0
        else:
            doc = frappe.new_doc("Customer RFM Score")
            doc.customer = cust.customer
            old_average = 0
        
        # Update scores
        doc.recency_score = r_score
        doc.frequency_score = f_score
        doc.monetary_score = m_score
        doc.payment_score = p_score
        doc.total_score = total_score
        doc.average_score = average_score
        doc.last_purchase_date = cust.last_purchase_date
        doc.days_since_purchase = days_since if days_since < 9999 else None
        doc.total_orders = cust.total_orders or 0
        doc.total_spent = cust.total_spent or 0
        doc.payment_terms_days = payment_data['payment_terms_days']
        doc.avg_days_to_pay = payment_data['avg_days_to_pay']
        doc.avg_days_late = payment_data['avg_days_late']
        doc.on_time_payments = payment_data['on_time_payments']
        doc.late_payments = payment_data['late_payments']
        doc.last_calculated = now_datetime()
        
        # Check for significant score change
        if old_average and abs(old_average - average_score) >= 0.5: # More sensitive for small scale
            doc.previous_average = old_average
            doc.score_changed_on = today
            
            # Create alert if enabled
            if settings.alert_on_downgrade and average_score < old_average:
                create_alert(cust.customer, "Downgrade", f"{old_average}", f"{average_score}")
                results["alerts_created"] += 1
            elif average_score > old_average:
                create_alert(cust.customer, "Upgrade", f"{old_average}", f"{average_score}")
        
        doc.save(ignore_permissions=True)
        results["processed"] += 1
    
    frappe.db.commit()
    return results


def calculate_payment_score_per_invoice(customer, payment_thresholds):
    """
    Calculate Payment Score by scoring EACH invoice individually (1-5) and averaging them.
    Logic:
    1. Get all Invoices (Paid, Unpaid, Overdue) - excluding Cancelled/Return.
    2. Check Maturity: If (Today - Posting Date) < Payment Terms Days -> SKIP (Too early to judge).
    3. Calculate Days Late:
       - If Fully Paid: (Last Payment Date - Due Date)
       - If Unpaid/Partial: (Today - Due Date)
    4. Score the "Days Late" using thresholds.
    5. Final P Score = Average of all invoice scores.
    """
    payment_terms_days = get_payment_terms_days(customer)
    today = getdate(nowdate())
    
    # Get all submitted invoices (not returns)
    invoices = frappe.db.sql("""
        SELECT 
            si.name,
            si.posting_date,
            si.due_date,
            si.grand_total,
            si.outstanding_amount
        FROM `tabSales Invoice` si
        WHERE si.customer = %s 
            AND si.docstatus = 1 
            AND si.is_return = 0
    """, (customer,), as_dict=True)
    
    if not invoices:
        return {
            'p_score': 5, # Default to 5 if no history? Or 1? Usually 5 (innocent until proven guilty)
            'payment_terms_days': payment_terms_days,
            'avg_days_to_pay': 0,
            'avg_days_late': 0,
            'on_time_payments': 0,
            'late_payments': 0
        }
    
    total_invoice_scores = 0
    valid_invoice_count = 0
    
    total_days_late_sum = 0 # For display stats only
    days_late_count = 0
    
    on_time = 0
    late = 0
    
    for inv in invoices:
        posting_date = getdate(inv.posting_date)
        
        # Determine Due Date (Use Invoice Due Date if set, else calculate)
        if inv.due_date:
            due_date = getdate(inv.due_date)
        else:
            due_date = add_days(posting_date, payment_terms_days)
            
        # Maturity Check: Has the payment term passed relative to TODAY?
        # If Today is before Due Date, we can't judge them yet (unless they already paid early!)
        # Exception: If they paid early, we should count it as a "Good" score (5).
        
        is_fully_paid = (inv.outstanding_amount <= 0.1) # Float tolerance
        
        effective_payment_date = None
        
        if is_fully_paid:
            # Get the date it was fully paid (max payment date)
            # We query the Payment Entry Reference to find the latest payment date for this invoice
            last_payment = frappe.db.sql("""
                SELECT MAX(pe.posting_date) as paid_date
                FROM `tabPayment Entry Reference` per
                JOIN `tabPayment Entry` pe ON per.parent = pe.name
                WHERE per.reference_name = %s AND pe.docstatus = 1
            """, (inv.name,))
            
            if last_payment and last_payment[0][0]:
                effective_payment_date = getdate(last_payment[0][0])
            else:
                # Fallback: If paid via Journal Entry or Credit Note, use posting date or today?
                # Let's assume on time if we can't find payment entry (safe default) or posting date
                effective_payment_date = posting_date 
                
        # --- Logic for Days Late ---
        if is_fully_paid:
            days_late = (effective_payment_date - due_date).days
        else:
            # Unpaid / Partially Paid
            # If Today < Due Date: It's NOT late yet. It's "Pending".
            # We should SKIP pending invoices unless we want to reward them for... existing?
            # User requirement: "if the customer have 90 days... and created 30 days ago we dont calculate it"
            if today < due_date:
                continue # Skip unmature invoice
            
            # If Today >= Due Date: It is Overdue.
            days_late = (today - due_date).days
        
        # Get Score for this specific invoice
        # Lower days late = Higher Score
        inv_score = get_score_from_thresholds(days_late, payment_thresholds, reverse=False)
        
        total_invoice_scores += inv_score
        valid_invoice_count += 1
        
        # Stats
        total_days_late_sum += days_late
        days_late_count += 1
        
        if days_late <= 0:
            on_time += 1
        else:
            late += 1
            
    # Calculate Final Average P Score
    if valid_invoice_count > 0:
        final_p_score = round(total_invoice_scores / valid_invoice_count, 1) # Keep decimal for accuracy? Or integer? R,F,M are integers.
        # R,F,M are integers 1-5. The api.py `get_score_from_thresholds` returns int.
        # But `average_score` is float.
        # Ideally P score should be int to match R,F,M? Or float?
        # Let's return float, and maybe round it to nearest int if needed, but float is more precise for "Average of invoices".
        # Actually, `total_score = r + f + m + p`. If p is float, total is float. That's fine.
        avg_days_late_display = round(total_days_late_sum / days_late_count, 1) if days_late_count else 0
    else:
        final_p_score = 5 # Default if no mature invoices found?
        avg_days_late_display = 0

    return {
        'p_score': final_p_score,
        'payment_terms_days': payment_terms_days,
        'avg_days_to_pay': 0, # Deprecated/Not calculated in this new logic easily
        'avg_days_late': avg_days_late_display,
        'on_time_payments': on_time,
        'late_payments': late
    }


def create_alert(customer, alert_type, old_score, new_score):
    """Create an RFM Alert record"""
    alert = frappe.new_doc("RFM Alert")
    alert.customer = customer
    alert.alert_type = alert_type
    alert.previous_segment = old_score
    alert.new_segment = new_score
    alert.created_on = now_datetime()
    alert.insert(ignore_permissions=True)


@frappe.whitelist()
def create_history_snapshot():
    """Create a daily snapshot of all RFM scores for trend analysis"""
    today = nowdate()
    
    scores = frappe.get_all("Customer RFM Score", 
        fields=["customer", "recency_score", "frequency_score", "monetary_score", "payment_score", "average_score"]
    )
    
    for score in scores:
        # Check if snapshot already exists for today
        exists = frappe.db.exists("RFM History", {
            "customer": score.customer,
            "snapshot_date": today
        })
        
        if not exists:
            history = frappe.new_doc("RFM History")
            history.customer = score.customer
            history.snapshot_date = today
            history.recency_score = score.recency_score
            history.frequency_score = score.frequency_score
            history.monetary_score = score.monetary_score
            history.segment = str(score.average_score)  # Store average as segment
            history.rfm_score = f"R{score.recency_score}-F{score.frequency_score}-M{score.monetary_score}-P{score.payment_score or 0}"
            history.insert(ignore_permissions=True)
    
    frappe.db.commit()
    return {"snapshots_created": len(scores)}


@frappe.whitelist()
def get_segment_distribution():
    """Get count of customers by average score ranges (1-5 Scale)"""
    data = frappe.db.sql("""
        SELECT 
            CASE 
                WHEN average_score >= 4.5 THEN 'Diamond (5)'
                WHEN average_score >= 3.5 THEN 'Gold (4)'
                WHEN average_score >= 2.5 THEN 'Silver (3)'
                WHEN average_score >= 1.5 THEN 'Bronze (2)'
                ELSE 'Standard (1)'
            END as segment,
            COUNT(*) as count,
            ROUND(AVG(average_score), 1) as avg_score
        FROM `tabCustomer RFM Score`
        WHERE average_score IS NOT NULL
        GROUP BY 
            CASE 
                WHEN average_score >= 4.5 THEN 'Diamond (5)'
                WHEN average_score >= 3.5 THEN 'Gold (4)'
                WHEN average_score >= 2.5 THEN 'Silver (3)'
                WHEN average_score >= 1.5 THEN 'Bronze (2)'
                ELSE 'Standard (1)'
            END
        ORDER BY avg_score DESC
    """, as_dict=True)
    
    return data


@frappe.whitelist()
def get_trend_data(customer=None, days=30):
    """Get historical segment data for trend charts"""
    from_date = add_days(nowdate(), -int(days))
    
    filters = {"snapshot_date": [">=", from_date]}
    if customer:
        filters["customer"] = customer
    
    data = frappe.get_all("RFM History",
        filters=filters,
        fields=["customer", "snapshot_date", "segment", "recency_score", "frequency_score", "monetary_score"],
        order_by="snapshot_date asc"
    )
    
    return data


@frappe.whitelist()
def get_alerts(limit=20, unread_only=True):
    """Get recent alerts"""
    filters = {}
    if unread_only:
        filters["is_read"] = 0
    
    alerts = frappe.get_all("RFM Alert",
        filters=filters,
        fields=["name", "customer", "customer_name", "alert_type", "previous_segment", "new_segment", "created_on", "is_read"],
        order_by="created_on desc",
        limit=int(limit)
    )
    
    return alerts


@frappe.whitelist()
def mark_alert_read(alert_name):
    """Mark an alert as read"""
    frappe.db.set_value("RFM Alert", alert_name, "is_read", 1)
    return {"success": True}
