frappe.pages['rfm-dashboard'].on_page_load = function (wrapper) {
    var page = frappe.ui.make_app_page({
        parent: wrapper,
        title: 'RFMP Analytics Dashboard',
        single_column: true
    });

    // Add Calculate button
    page.set_primary_action('Calculate RFMP Scores', () => {
        frappe.call({
            method: 'erfmpnext.erfmpnext.api.calculate_rfm_scores',
            freeze: true,
            freeze_message: 'Calculating RFMP scores...',
            callback: function (r) {
                if (r.message) {
                    frappe.msgprint({
                        title: 'RFMP Calculation Complete',
                        message: `Processed ${r.message.processed} customers. Created ${r.message.alerts_created} alerts.`,
                        indicator: 'green'
                    });
                    load_dashboard(page);
                }
            },
            error: function (r) {
                frappe.msgprint({
                    title: 'Calculation Error',
                    message: JSON.stringify(r),
                    indicator: 'red'
                });
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
        <div class="rfmp-dashboard">
            <div class="row">
                <div class="col-md-6">
                    <div class="card mb-4">
                        <div class="card-header">
                            <h5 class="mb-0">📊 Score Distribution (1-5 Scale)</h5>
                        </div>
                        <div class="card-body">
                            <div id="segment-chart" style="min-height: 250px;"></div>
                        </div>
                    </div>
                </div>
                <div class="col-md-6">
                    <div class="card mb-4">
                        <div class="card-header">
                            <h5 class="mb-0">🔔 Recent Alerts</h5>
                        </div>
                        <div class="card-body">
                            <div id="alerts-list" style="max-height: 250px; overflow-y: auto;"></div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="row">
                <div class="col-12">
                    <div class="card mb-4">
                        <div class="card-header d-flex justify-content-between align-items-center">
                            <h5 class="mb-0">👥 Customer Scores</h5>
                            <div class="d-flex gap-2">
                                <select id="score-filter" class="form-control" style="width: 150px;">
                                    <option value="">All Scores</option>
                                    <option value="4.5">5 (Diamond)</option>
                                    <option value="3.5">4 (Gold)</option>
                                    <option value="2.5">3 (Silver)</option>
                                    <option value="1.5">2 (Bronze)</option>
                                    <option value="0">1 (Standard)</option>
                                </select>
                            </div>
                        </div>
                        <div class="card-body">
                            <div id="customers-table"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <style>
            .rfmp-dashboard .card {
                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                border: none;
                border-radius: 8px;
            }
            .rfmp-dashboard .card-header {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border-radius: 8px 8px 0 0;
                padding: 15px 20px;
            }
            .rfmp-dashboard .card-body {
                padding: 20px;
            }
            .score-badge {
                display: inline-block;
                width: 28px;
                height: 28px;
                line-height: 28px;
                text-align: center;
                border-radius: 50%;
                font-weight: bold;
                font-size: 12px;
            }
            .score-diamond { background: #10b981; color: white; }
            .score-gold { background: #f59e0b; color: white; }
            .score-silver { background: #9ca3af; color: white; }
            .score-bronze { background: #b45309; color: white; }
            .score-standard { background: #ef4444; color: white; }
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
            .avg-score {
                font-size: 18px;
                font-weight: bold;
                padding: 4px 12px;
                border-radius: 20px;
            }
        </style>
    `);

    // Load segment distribution
    frappe.call({
        method: 'erfmpnext.erfmpnext.api.get_segment_distribution',
        callback: function (r) {
            if (r.message && r.message.length) {
                render_segment_chart(r.message);
            } else {
                $('#segment-chart').html('<p class="text-muted text-center">No data yet. Click "Calculate RFMP Scores" to start.</p>');
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

    // Filter change handler (attached to wrapper to ensure it persists if inner HTML changes)
    $(page.wrapper).on('change', '#score-filter', function () {
        load_customers_table($(this).val());
    });
}

function render_segment_chart(data) {
    const colors = {
        'Diamond (5)': '#10b981',
        'Gold (4)': '#f59e0b',
        'Silver (3)': '#9ca3af',
        'Bronze (2)': '#b45309',
        'Standard (1)': '#ef4444'
    };

    let html = '<div class="segment-bars">';
    const total = data.reduce((sum, d) => sum + d.count, 0);

    data.forEach(d => {
        const pct = ((d.count / total) * 100).toFixed(1);
        const color = colors[d.segment] || '#6b7280';
        html += `
            <div class="mb-3">
                <div class="d-flex justify-content-between mb-1">
                    <span><span class="segment-badge" style="background: ${color}; color: white; padding: 4px 12px; border-radius: 12px;">${d.segment}</span></span>
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
                    <small class="text-muted">Score: ${a.previous_segment} → ${a.new_segment}</small>
                </div>
                <small class="text-muted">${frappe.datetime.prettyDate(a.created_on)}</small>
            </div>
        `;
    });
    $('#alerts-list').html(html);
}

function load_customers_table(min_score) {
    // Show Loading State
    $('#customers-table').html(`
        <div class="text-center p-5">
            <div class="spinner-border text-primary" role="status"></div>
            <p class="mt-2 text-muted">Loading customer data...</p>
        </div>
    `);

    let filters = [];
    if (min_score !== undefined && min_score !== null && min_score !== "") {
        filters.push(["average_score", ">=", parseFloat(min_score)]);
    }

    frappe.call({
        method: 'frappe.client.get_list',
        args: {
            doctype: 'Customer RFM Score',
            filters: filters,
            fields: ['name', 'customer', 'customer_name', 'recency_score', 'frequency_score', 'monetary_score', 'payment_score', 'average_score', 'total_spent', 'total_orders', 'days_since_purchase', 'avg_days_late'],
            order_by: 'average_score desc',
            limit_page_length: 50
        },
        callback: function (r) {
            try {
                if (r.message && r.message.length) {
                    let html = `
                        <table class="table table-hover">
                            <thead>
                                <tr>
                                    <th>Customer</th>
                                    <th>R</th>
                                    <th>F</th>
                                    <th>M</th>
                                    <th>P</th>
                                    <th>Avg</th>
                                    <th>Total Spent</th>
                                    <th>Orders</th>
                                    <th>Days Late</th>
                                </tr>
                            </thead>
                            <tbody>
                    `;
                    r.message.forEach(c => {
                        const avgClass = get_score_class(c.average_score);
                        html += `
                            <tr style="cursor: pointer;" onclick="frappe.set_route('Form', 'Customer RFM Score', '${c.name || c.customer}')">
                                <td><strong>${c.customer_name || c.customer}</strong></td>
                                <td><span class="score-badge ${get_score_badge_class(c.recency_score)}">${c.recency_score || '-'}</span></td>
                                <td><span class="score-badge ${get_score_badge_class(c.frequency_score)}">${c.frequency_score || '-'}</span></td>
                                <td><span class="score-badge ${get_score_badge_class(c.monetary_score)}">${c.monetary_score || '-'}</span></td>
                                <td><span class="score-badge ${get_score_badge_class(c.payment_score)}">${c.payment_score || '-'}</span></td>
                                <td><span class="avg-score ${avgClass}">${(c.average_score || 0).toFixed(1)}</span></td>
                                <td>${format_currency(c.total_spent || 0)}</td>
                                <td>${c.total_orders || 0}</td>
                                <td>${c.avg_days_late != null ? (c.avg_days_late > 0 ? '+' : '') + c.avg_days_late.toFixed(0) + 'd' : '-'}</td>
                            </tr>
                        `;
                    });
                    html += '</tbody></table>';
                    $('#customers-table').html(html);
                } else {
                    $('#customers-table').html(`
                        <div class="text-center p-4">
                            <p class="text-muted">No customers found matching filter.</p>
                            <button class="btn btn-primary btn-sm" onclick="frappe.pages['rfm-dashboard'].get_primary_btn().trigger('click')">
                                Calculate Scores Now
                            </button>
                        </div>
                    `);
                }
            } catch (e) {
                console.error(e);
                $('#customers-table').html(`<div class="alert alert-danger">JS Error: ${e.message}</div>`);
            }
        },
        error: function (r) {
            console.log(r);
            let msg = 'Unknown error';
            try {
                if (r.message) msg = JSON.stringify(r.message);
                if (r.exc) msg += '<br>' + r.exc;
            } catch (e) { msg = r; }

            $('#customers-table').html(`
                <div class="alert alert-danger">
                    <strong>Data Load Error:</strong><br>
                    It seems the database is not updated.<br>
                    <small style="font-size: 10px; font-family: monospace;">${msg}</small><br>
                    <hr>
                    <strong>Fix:</strong> Run <code>bench migrate</code> on your server.
                </div>
            `);
        }
    });
}

function get_score_class(score) {
    if (score >= 4.5) return 'score-diamond';
    if (score >= 3.5) return 'score-gold';
    if (score >= 2.5) return 'score-silver';
    if (score >= 1.5) return 'score-bronze';
    return 'score-standard';
}

function get_score_badge_class(score) {
    if (score >= 5) return 'score-diamond';
    if (score >= 4) return 'score-gold';
    if (score >= 3) return 'score-silver';
    if (score >= 2) return 'score-bronze';
    return 'score-standard';
}

function format_currency(value) {
    try {
        let currency = frappe.boot.sysdefaults.currency || 'USD';
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency }).format(value);
    } catch (e) {
        return (value || 0).toFixed(2);
    }
}
