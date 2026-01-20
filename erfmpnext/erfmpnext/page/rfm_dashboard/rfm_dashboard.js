frappe.pages['rfm-dashboard'].on_page_load = function (wrapper) {
    var page = frappe.ui.make_app_page({
        parent: wrapper,
        title: 'RFM Analytics Dashboard',
        single_column: true
    });

    // Add Calculate button
    page.set_primary_action('Calculate RFM Scores', () => {
        frappe.call({
            method: 'erfmpnext.erfmpnext.api.calculate_rfm_scores',
            freeze: true,
            freeze_message: 'Calculating RFM scores...',
            callback: function (r) {
                if (r.message) {
                    frappe.msgprint({
                        title: 'RFM Calculation Complete',
                        message: `Processed ${r.message.processed} customers. Created ${r.message.alerts_created} alerts.`,
                        indicator: 'green'
                    });
                    load_dashboard(page);
                }
            }
        });
    });

    // Add Settings button
    page.set_secondary_action('Settings', () => {
        frappe.set_route('Form', 'RFM Settings');
    });

    load_dashboard(page);
};

function load_dashboard(page) {
    page.body.html(`
		<div class="rfm-dashboard">
			<div class="row">
				<div class="col-md-6">
					<div class="card mb-4">
						<div class="card-header">
							<h5 class="mb-0">📊 Segment Distribution</h5>
						</div>
						<div class="card-body">
							<div id="segment-chart" style="min-height: 300px;"></div>
						</div>
					</div>
				</div>
				<div class="col-md-6">
					<div class="card mb-4">
						<div class="card-header">
							<h5 class="mb-0">🔔 Recent Alerts</h5>
						</div>
						<div class="card-body">
							<div id="alerts-list" style="max-height: 300px; overflow-y: auto;"></div>
						</div>
					</div>
				</div>
			</div>
			<div class="row">
				<div class="col-12">
					<div class="card mb-4">
						<div class="card-header d-flex justify-content-between align-items-center">
							<h5 class="mb-0">👥 Customers by Segment</h5>
							<select id="segment-filter" class="form-control" style="width: 200px;">
								<option value="">All Segments</option>
								<option value="Champions">Champions</option>
								<option value="Loyal">Loyal</option>
								<option value="Potential Loyalists">Potential Loyalists</option>
								<option value="At Risk">At Risk</option>
								<option value="Cant Lose">Can't Lose</option>
								<option value="Lost">Lost</option>
							</select>
						</div>
						<div class="card-body">
							<div id="customers-table"></div>
						</div>
					</div>
				</div>
			</div>
		</div>
		<style>
			.rfm-dashboard .card {
				box-shadow: 0 2px 8px rgba(0,0,0,0.1);
				border: none;
				border-radius: 8px;
			}
			.rfm-dashboard .card-header {
				background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
				color: white;
				border-radius: 8px 8px 0 0;
				padding: 15px 20px;
			}
			.rfm-dashboard .card-body {
				padding: 20px;
			}
			.segment-badge {
				padding: 4px 12px;
				border-radius: 12px;
				font-size: 12px;
				font-weight: 500;
			}
			.segment-Champions { background: #10b981; color: white; }
			.segment-Loyal { background: #3b82f6; color: white; }
			.segment-At-Risk { background: #f59e0b; color: white; }
			.segment-Lost { background: #ef4444; color: white; }
			.segment-default { background: #6b7280; color: white; }
			.alert-item {
				padding: 12px;
				border-bottom: 1px solid #eee;
				display: flex;
				justify-content: space-between;
				align-items: center;
			}
			.alert-item:last-child { border-bottom: none; }
			.alert-downgrade { border-left: 4px solid #ef4444; }
			.alert-upgrade { border-left: 4px solid #10b981; }
		</style>
	`);

    // Load segment distribution
    frappe.call({
        method: 'erfmpnext.erfmpnext.api.get_segment_distribution',
        callback: function (r) {
            if (r.message && r.message.length) {
                render_segment_chart(r.message);
            } else {
                $('#segment-chart').html('<p class="text-muted text-center">No data yet. Click "Calculate RFM Scores" to start.</p>');
            }
        }
    });

    // Load alerts
    frappe.call({
        method: 'erfmpnext.erfmpnext.api.get_alerts',
        args: { limit: 10, unread_only: false },
        callback: function (r) {
            render_alerts(r.message || []);
        }
    });

    // Load customers table
    load_customers_table();

    // Filter change handler
    $('#segment-filter').on('change', function () {
        load_customers_table($(this).val());
    });
}

function render_segment_chart(data) {
    const colors = {
        'Champions': '#10b981',
        'Loyal': '#3b82f6',
        'Potential Loyalists': '#8b5cf6',
        'New Customers': '#06b6d4',
        'Promising': '#84cc16',
        'Need Attention': '#eab308',
        'About to Sleep': '#f97316',
        'At Risk': '#f59e0b',
        'Cant Lose': '#ec4899',
        'Hibernating': '#6b7280',
        'Lost': '#ef4444'
    };

    let html = '<div class="segment-bars">';
    const total = data.reduce((sum, d) => sum + d.count, 0);

    data.forEach(d => {
        const pct = ((d.count / total) * 100).toFixed(1);
        const color = colors[d.segment] || '#6b7280';
        html += `
			<div class="mb-3">
				<div class="d-flex justify-content-between mb-1">
					<span><span class="segment-badge" style="background: ${color}; color: white;">${d.segment}</span></span>
					<span class="font-weight-bold">${d.count} (${pct}%)</span>
				</div>
				<div class="progress" style="height: 8px;">
					<div class="progress-bar" style="width: ${pct}%; background: ${color};"></div>
				</div>
			</div>
		`;
    });
    html += '</div>';
    $('#segment-chart').html(html);
}

function render_alerts(alerts) {
    if (!alerts.length) {
        $('#alerts-list').html('<p class="text-muted text-center">No alerts</p>');
        return;
    }

    let html = '';
    alerts.forEach(a => {
        const alertClass = a.alert_type === 'Downgrade' ? 'alert-downgrade' : 'alert-upgrade';
        const icon = a.alert_type === 'Downgrade' ? '⬇️' : '⬆️';
        html += `
			<div class="alert-item ${alertClass}">
				<div>
					<strong>${icon} ${a.customer_name}</strong><br>
					<small class="text-muted">${a.previous_segment} → ${a.new_segment}</small>
				</div>
				<small class="text-muted">${frappe.datetime.prettyDate(a.created_on)}</small>
			</div>
		`;
    });
    $('#alerts-list').html(html);
}

function load_customers_table(segment_filter) {
    let filters = {};
    if (segment_filter) {
        filters.segment = segment_filter;
    }

    frappe.call({
        method: 'frappe.client.get_list',
        args: {
            doctype: 'Customer RFM Score',
            filters: filters,
            fields: ['customer', 'customer_name', 'recency_score', 'frequency_score', 'monetary_score', 'segment', 'total_spent', 'total_orders', 'days_since_purchase'],
            order_by: 'total_spent desc',
            limit_page_length: 50
        },
        callback: function (r) {
            if (r.message && r.message.length) {
                let html = `
					<table class="table table-hover">
						<thead>
							<tr>
								<th>Customer</th>
								<th>R</th>
								<th>F</th>
								<th>M</th>
								<th>Segment</th>
								<th>Total Spent</th>
								<th>Orders</th>
								<th>Days Since Purchase</th>
							</tr>
						</thead>
						<tbody>
				`;
                r.message.forEach(c => {
                    const segmentClass = 'segment-' + (c.segment || '').replace(/\s+/g, '-');
                    html += `
						<tr style="cursor: pointer;" onclick="frappe.set_route('Form', 'Customer', '${c.customer}')">
							<td><strong>${c.customer_name || c.customer}</strong></td>
							<td>${c.recency_score || '-'}</td>
							<td>${c.frequency_score || '-'}</td>
							<td>${c.monetary_score || '-'}</td>
							<td><span class="segment-badge ${segmentClass} segment-default">${c.segment || '-'}</span></td>
							<td>${format_currency(c.total_spent || 0)}</td>
							<td>${c.total_orders || 0}</td>
							<td>${c.days_since_purchase != null ? c.days_since_purchase + ' days' : '-'}</td>
						</tr>
					`;
                });
                html += '</tbody></table>';
                $('#customers-table').html(html);
            } else {
                $('#customers-table').html('<p class="text-muted text-center">No customers found. Run RFM calculation first.</p>');
            }
        }
    });
}

function format_currency(value) {
    return frappe.format(value, { fieldtype: 'Currency' });
}
