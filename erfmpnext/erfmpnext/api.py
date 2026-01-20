# Copyright (c) 2025, Your Company and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.utils import nowdate, getdate, add_days, now_datetime

# Segment definitions based on RFM scores
SEGMENT_MAP = {
    (5, 5, 5): "Champions",
    (5, 5, 4): "Champions",
    (5, 4, 5): "Champions",
    (4, 5, 5): "Loyal",
    (5, 5, 3): "Loyal",
    (4, 5, 4): "Loyal",
    (4, 4, 5): "Loyal",
    (4, 4, 4): "Loyal",
    (5, 4, 4): "Loyal",
    (5, 3, 3): "Potential Loyalists",
    (4, 3, 3): "Potential Loyalists",
    (5, 2, 2): "Potential Loyalists",
    (4, 2, 3): "Potential Loyalists",
    (5, 1, 1): "New Customers",
    (5, 1, 2): "New Customers",
    (4, 1, 1): "New Customers",
    (4, 2, 1): "Promising",
    (3, 3, 3): "Need Attention",
    (3, 3, 2): "Need Attention",
    (3, 2, 3): "Need Attention",
    (2, 3, 3): "About to Sleep",
    (2, 2, 3): "About to Sleep",
    (2, 3, 2): "About to Sleep",
    (2, 5, 5): "At Risk",
    (2, 5, 4): "At Risk",
    (2, 4, 5): "At Risk",
    (2, 4, 4): "At Risk",
    (1, 5, 5): "Cant Lose",
    (1, 5, 4): "Cant Lose",
    (1, 4, 5): "Cant Lose",
    (2, 2, 2): "Hibernating",
    (2, 2, 1): "Hibernating",
    (2, 1, 2): "Hibernating",
    (1, 2, 2): "Hibernating",
    (1, 1, 1): "Lost",
    (1, 1, 2): "Lost",
    (1, 2, 1): "Lost",
}


def get_segment(r, f, m):
    """Get segment name from RFM scores"""
    key = (r, f, m)
    if key in SEGMENT_MAP:
        return SEGMENT_MAP[key]
    
    # Fallback logic for scores not in map
    avg = (r + f + m) / 3
    if avg >= 4:
        return "Loyal"
    elif avg >= 3:
        return "Need Attention"
    elif avg >= 2:
        return "Hibernating"
    else:
        return "Lost"


def get_segment_rank(segment):
    """Get numeric rank for segment comparison (higher = better)"""
    ranks = {
        "Champions": 10,
        "Loyal": 9,
        "Potential Loyalists": 8,
        "New Customers": 7,
        "Promising": 6,
        "Need Attention": 5,
        "About to Sleep": 4,
        "At Risk": 3,
        "Cant Lose": 2,
        "Hibernating": 1,
        "Lost": 0
    }
    return ranks.get(segment, 5)


@frappe.whitelist()
def calculate_rfm_scores():
    """Calculate RFM scores for all customers based on Sales Invoices"""
    settings = frappe.get_single("RFM Settings")
    today = getdate(nowdate())
    period_start = add_days(today, -settings.analysis_period_days or -365)
    
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
            AND si.posting_date >= %s
        GROUP BY c.name, c.customer_name
    """, (period_start,), as_dict=True)
    
    results = {"processed": 0, "alerts_created": 0}
    
    for cust in customer_data:
        # Calculate days since last purchase
        if cust.last_purchase_date:
            days_since = (today - getdate(cust.last_purchase_date)).days
        else:
            days_since = 9999  # Never purchased
        
        # Calculate R score
        r_score = calculate_r_score(days_since, settings)
        
        # Calculate F score
        f_score = calculate_f_score(cust.total_orders or 0, settings)
        
        # Calculate M score
        m_score = calculate_m_score(cust.total_spent or 0, settings)
        
        # Get segment
        segment = get_segment(r_score, f_score, m_score)
        
        # Get or create Customer RFM Score record
        existing = frappe.db.exists("Customer RFM Score", cust.customer)
        
        if existing:
            doc = frappe.get_doc("Customer RFM Score", cust.customer)
            old_segment = doc.segment
        else:
            doc = frappe.new_doc("Customer RFM Score")
            doc.customer = cust.customer
            old_segment = None
        
        # Update scores
        doc.recency_score = r_score
        doc.frequency_score = f_score
        doc.monetary_score = m_score
        doc.segment = segment
        doc.last_purchase_date = cust.last_purchase_date
        doc.days_since_purchase = days_since if days_since < 9999 else None
        doc.total_orders = cust.total_orders or 0
        doc.total_spent = cust.total_spent or 0
        doc.last_calculated = now_datetime()
        
        # Check for segment change
        if old_segment and old_segment != segment:
            doc.previous_segment = old_segment
            doc.segment_changed_on = today
            
            # Create alert if enabled
            if settings.alert_on_downgrade:
                old_rank = get_segment_rank(old_segment)
                new_rank = get_segment_rank(segment)
                
                if new_rank < old_rank:
                    create_alert(cust.customer, "Downgrade", old_segment, segment)
                    results["alerts_created"] += 1
                elif new_rank > old_rank:
                    create_alert(cust.customer, "Upgrade", old_segment, segment)
        
        doc.save(ignore_permissions=True)
        results["processed"] += 1
    
    frappe.db.commit()
    return results


def calculate_r_score(days_since, settings):
    """Calculate Recency score based on days since last purchase"""
    if days_since <= (settings.recency_days_5 or 30):
        return 5
    elif days_since <= (settings.recency_days_4 or 60):
        return 4
    elif days_since <= (settings.recency_days_3 or 90):
        return 3
    elif days_since <= (settings.recency_days_2 or 180):
        return 2
    else:
        return 1


def calculate_f_score(total_orders, settings):
    """Calculate Frequency score based on number of orders"""
    if total_orders >= (settings.frequency_orders_5 or 10):
        return 5
    elif total_orders >= (settings.frequency_orders_4 or 7):
        return 4
    elif total_orders >= (settings.frequency_orders_3 or 4):
        return 3
    elif total_orders >= (settings.frequency_orders_2 or 2):
        return 2
    else:
        return 1


def calculate_m_score(total_spent, settings):
    """Calculate Monetary score based on total spend"""
    if total_spent >= (settings.monetary_amount_5 or 50000):
        return 5
    elif total_spent >= (settings.monetary_amount_4 or 25000):
        return 4
    elif total_spent >= (settings.monetary_amount_3 or 10000):
        return 3
    elif total_spent >= (settings.monetary_amount_2 or 5000):
        return 2
    else:
        return 1


def create_alert(customer, alert_type, old_segment, new_segment):
    """Create an RFM Alert record"""
    alert = frappe.new_doc("RFM Alert")
    alert.customer = customer
    alert.alert_type = alert_type
    alert.previous_segment = old_segment
    alert.new_segment = new_segment
    alert.created_on = now_datetime()
    alert.insert(ignore_permissions=True)


@frappe.whitelist()
def create_history_snapshot():
    """Create a daily snapshot of all RFM scores for trend analysis"""
    today = nowdate()
    
    scores = frappe.get_all("Customer RFM Score", 
        fields=["customer", "recency_score", "frequency_score", "monetary_score", "segment", "rfm_score"]
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
            history.segment = score.segment
            history.rfm_score = score.rfm_score
            history.insert(ignore_permissions=True)
    
    frappe.db.commit()
    return {"snapshots_created": len(scores)}


@frappe.whitelist()
def get_segment_distribution():
    """Get count of customers in each segment"""
    data = frappe.db.sql("""
        SELECT segment, COUNT(*) as count
        FROM `tabCustomer RFM Score`
        WHERE segment IS NOT NULL AND segment != ''
        GROUP BY segment
        ORDER BY count DESC
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
