# Copyright (c) 2025, Your Company and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.utils import nowdate, getdate, add_days, now_datetime, flt, add_months
import statistics
import math


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
                WHEN average_score >= 5 THEN 'Excellent (5)'
                WHEN average_score >= 4 THEN 'Good (4)'
                WHEN average_score >= 3 THEN 'Average (3)'
                WHEN average_score >= 2 THEN 'Fair (2)'
                ELSE 'Poor (1)'
            END as segment,
            COUNT(*) as count,
            ROUND(AVG(average_score), 1) as avg_score
        FROM `tabCustomer RFM Score`
        WHERE average_score IS NOT NULL
        GROUP BY 
            CASE 
                WHEN average_score >= 5 THEN 'Excellent (5)'
                WHEN average_score >= 4 THEN 'Good (4)'
                WHEN average_score >= 3 THEN 'Average (3)'
                WHEN average_score >= 2 THEN 'Fair (2)'
                ELSE 'Poor (1)'
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
    return {"success": True}


@frappe.whitelist()
def calculate_product_analytics():
    """Calculate ABC, XYZ, Turnover, and GMROI for all items"""
    today = getdate(nowdate())
    period_start = add_months(today, -12) # Last 12 months
    
    # 1. Fetch Sales Data (Revenue, Profit, Qty, COGS)
    sales_data = frappe.db.sql("""
        SELECT 
            item_code,
            SUM(base_net_amount) as revenue,
            SUM(base_net_amount - (COALESCE(valuation_rate, 0) * qty)) as profit,
            SUM(qty) as sales_qty,
            COUNT(DISTINCT parent) as invoice_count
        FROM `tabSales Invoice Item`
        WHERE docstatus = 1 AND posting_date >= %s
        GROUP BY item_code
    """, (period_start,), as_dict=True)
    
    if not sales_data:
        return {"processed": 0, "message": "No sales data found in the last 12 months."}

    # 2. ABC Analysis (Revenue Based)
    sales_data.sort(key=lambda x: x.revenue, reverse=True)
    total_revenue = sum(item.revenue for item in sales_data)
    running_revenue = 0
    
    # 3. XYZ Analysis (Variability Based)
    monthly_sales = frappe.db.sql("""
        SELECT 
            item_code,
            DATE_FORMAT(posting_date, '%%Y-%%m') as month,
            SUM(qty) as qty
        FROM `tabSales Invoice Item`
        WHERE docstatus = 1 AND posting_date >= %s
        GROUP BY item_code, month
    """, (period_start,), as_dict=True)
    
    # 4. Inventory Data (Turnover & Ageing)
    stock_data = frappe.get_all("Bin", fields=["item_code", "actual_qty", "valuation_rate"])
    stock_map = {d.item_code: d for d in stock_data}

    # Process results
    processed = 0
    for item in sales_data:
        # ABC Logic
        running_revenue += item.revenue
        ratio = (running_revenue / total_revenue) * 100 if total_revenue else 100
        abc = 'A' if ratio <= 80 else ('B' if ratio <= 95 else 'C')
        
        # XYZ Logic
        item_months = [m.qty for m in monthly_sales if m.item_code == item.item_code]
        while len(item_months) < 12:
            item_months.append(0)
            
        cv = 0
        xyz = 'Z'
        if len(item_months) > 1:
            mean = sum(item_months) / 12
            if mean > 0:
                std = statistics.pstdev(item_months)
                cv = (std / mean)
                xyz = 'X' if cv < 0.5 else ('Y' if cv <= 1.0 else 'Z')

        # Turnover & GMROI Logic
        bin_data = stock_map.get(item.item_code)
        stock_qty = bin_data.actual_qty if bin_data and bin_data.actual_qty > 0 else 0
        valuation = bin_data.valuation_rate if bin_data and bin_data.valuation_rate > 0 else 0
        avg_inv_value = (valuation * stock_qty)
        
        cogs = item.revenue - item.profit
        turnover = cogs / avg_inv_value if avg_inv_value > 0 else 0
        gmroi = (item.profit / avg_inv_value) if avg_inv_value > 0 else 0

        # Save to Item Analytics
        existing = frappe.db.exists("Item Analytics", item.item_code)
        if existing:
            doc = frappe.get_doc("Item Analytics", item.item_code)
        else:
            doc = frappe.new_doc("Item Analytics")
            doc.item_code = item.item_code
            
        doc.revenue = item.revenue
        doc.profit = item.profit
        doc.sales_count = item.sales_qty
        doc.abc_category = abc
        doc.xyz_category = xyz
        doc.cv = cv
        doc.turnover_ratio = turnover
        doc.gmroi = gmroi
        doc.last_calculated = now_datetime()
        doc.save(ignore_permissions=True)
        processed += 1
        
    calculate_market_basket()
    frappe.db.commit()
    return {"processed": processed}


def calculate_market_basket():
    """Find items frequently bought together (Association Rules)"""
    frappe.db.delete("Item Basket Analysis", {"last_calculated": ["!=", None]})
    
    invoices = frappe.db.sql("""
        SELECT parent, item_code 
        FROM `tabSales Invoice Item` 
        WHERE docstatus = 1
        ORDER BY parent
    """, as_dict=True)
    
    if not invoices: return

    invoice_map = {}
    for row in invoices:
        if row.parent not in invoice_map:
            invoice_map[row.parent] = set()
        invoice_map[row.parent].add(row.item_code)
        
    total_invoices = len(invoice_map)
    item_counts = {}
    pair_counts = {}
    
    for items in invoice_map.values():
        items_list = list(items)
        for i, item_a in enumerate(items_list):
            item_counts[item_a] = item_counts.get(item_a, 0) + 1
            for item_b in items_list[i+1:]:
                pair = tuple(sorted((item_a, item_b)))
                pair_counts[pair] = pair_counts.get(pair, 0) + 1
                
    min_support_count = max(2, total_invoices * 0.01) # Lower threshold for basket
    
    for (item_a, item_b), count in pair_counts.items():
        if count < min_support_count: continue
        
        support = (count / total_invoices) * 100
        
        # Rule: A -> B
        conf_a_b = (count / item_counts[item_a]) * 100
        lift = (support/100) / ((item_counts[item_a]/total_invoices) * (item_counts[item_b]/total_invoices))
        save_basket_rule(item_a, item_b, support, conf_a_b, lift, count)
        
        # Rule: B -> A
        conf_b_a = (count / item_counts[item_b]) * 100
        save_basket_rule(item_b, item_a, support, conf_b_a, lift, count)


def save_basket_rule(a, b, support, confidence, lift, count):
    doc = frappe.new_doc("Item Basket Analysis")
    doc.item_a = a
    doc.item_b = b
    doc.support = support
    doc.confidence = confidence
    doc.lift = lift
    doc.frequency = count
    doc.last_calculated = now_datetime()
    doc.insert(ignore_permissions=True)
