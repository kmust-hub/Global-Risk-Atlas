from __future__ import annotations

import csv
import json
import time
import urllib.request
from datetime import date
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'exports'
OUT.mkdir(parents=True, exist_ok=True)
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'


def fetch_json(url: str):
    last_error = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': UA,
                'Referer': 'https://gu.qq.com/',
                'Accept': 'application/json,text/plain,*/*',
            })
            with urllib.request.urlopen(req, timeout=45) as response:
                return json.loads(response.read().decode('utf-8', 'replace'))
        except Exception as exc:
            last_error = exc
            time.sleep(0.6 * (attempt + 1))
    raise RuntimeError(f'Fetch failed: {url}') from last_error


def fetch_tencent(symbol: str, start: str, end: str):
    url = (
        'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
        f'?param={symbol},day,{start},{end},2000,qfq&_={int(time.time() * 1000)}'
    )
    payload = fetch_json(url)
    node = payload['data'][symbol]
    rows = node.get('qfqday') or node.get('day') or []
    result = []
    for row in rows:
        result.append({
            'date': row[0],
            'open': float(row[1]),
            'close': float(row[2]),
            'high': float(row[3]),
            'low': float(row[4]),
            'volume': int(float(row[5])),
            'source': '腾讯行情',
        })
    return result


def fetch_sina(symbol: str):
    url = (
        'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/'
        f'CN_MarketData.getKLineData?symbol={symbol}&scale=240&ma=no&datalen=10000&_={int(time.time() * 1000)}'
    )
    payload = fetch_json(url)
    return [{
        'date': row['day'],
        'open': float(row['open']),
        'close': float(row['close']),
        'high': float(row['high']),
        'low': float(row['low']),
        'volume': int(float(row['volume'])),
        'source': '新浪行情',
    } for row in payload]


def dedupe(rows):
    by_date = {}
    for row in rows:
        by_date[row['date']] = row
    return [by_date[d] for d in sorted(by_date)]


def merge_preferred(primary, secondary):
    by_date = {row['date']: row for row in secondary}
    for row in primary:
        by_date[row['date']] = row
    return [by_date[d] for d in sorted(by_date)]


def sanitize_ohlc(rows):
    adjusted = []
    for row in rows:
        high = max(row['high'], row['open'], row['close'])
        low = min(row['low'], row['open'], row['close'])
        if high != row['high'] or low != row['low']:
            adjusted.append({'date': row['date'], 'old_high': row['high'], 'new_high': high, 'old_low': row['low'], 'new_low': low})
            row['high'] = high
            row['low'] = low
        row['volume'] = max(0, int(row['volume']))
    return adjusted


def change_pct(rows):
    previous = None
    for row in rows:
        row['change_pct'] = None if previous is None else (row['close'] / previous - 1) * 100
        previous = row['close']
    return rows


def build_dividend():
    tencent = []
    for start, end in [
        ('2008-01-01', '2015-12-31'),
        ('2016-01-01', '2020-12-31'),
        ('2021-01-01', '2026-10-21'),
    ]:
        tencent.extend(fetch_tencent('sh000922', start, end))
    tencent = dedupe(change_pct(tencent))
    first_tencent = tencent[0]['date']
    sina = fetch_sina('sh000922')
    early = [row for row in sina if row['date'] < first_tencent]
    combined = dedupe(early + tencent)
    return change_pct(combined), tencent, sina


def build_chinext():
    rows = []
    for start, end in [
        ('2010-01-01', '2017-12-31'),
        ('2018-01-01', '2022-12-31'),
        ('2023-01-01', '2026-10-21'),
    ]:
        rows.extend(fetch_tencent('sz399006', start, end))
    rows = dedupe(change_pct(rows))
    sina = fetch_sina('sz399006')
    return rows, sina


def monthly_closes(rows):
    monthly = {}
    for row in rows:
        monthly[row['date'][:7]] = row['close']
    return monthly


def add_ma_rows(dividend, chinext):
    monthly = monthly_closes(dividend)
    merged = []
    cyb_map = {row['date']: row['close'] for row in chinext}
    for row in dividend:
        if row['date'] not in cyb_map:
            continue
        month = row['date'][:7]
        prior = [value for ym, value in sorted(monthly.items()) if ym < month]
        closes90 = prior[-89:] + [row['close']]
        closes40 = prior[-39:] + [row['close']]
        ma90 = sum(closes90) / 90 if len(closes90) == 90 else None
        ma40 = sum(closes40) / 40 if len(closes40) == 40 else None
        cyb_close = cyb_map[row['date']]
        merged.append({
            'date': row['date'],
            'zzhl_close': row['close'],
            'cyb_close': cyb_close,
            'R': cyb_close / row['close'],
            'zzhl_ma90': ma90,
            'zzhl_ma40': ma40,
            'zzhl_dist90_pct': (row['close'] / ma90 - 1) * 100 if ma90 else None,
            'zzhl_dist40_pct': (row['close'] / ma40 - 1) * 100 if ma40 else None,
        })
    return merged


def validate(rows, name):
    assert rows, f'{name} is empty'
    dates = [row['date'] for row in rows]
    assert dates == sorted(dates), f'{name} not sorted'
    assert len(dates) == len(set(dates)), f'{name} has duplicate dates'
    for row in rows:
        assert min(row['open'], row['high'], row['low'], row['close']) > 0
        tolerance = max(0.01, abs(row['close']) * 1e-6)
        assert row['high'] >= max(row['open'], row['close']) - tolerance, f"{name} bad high: {row}"
        assert row['low'] <= min(row['open'], row['close']) + tolerance, f"{name} bad low: {row}"
        assert row['volume'] >= 0


def overlap_check(tencent, sina):
    sina_map = {row['date']: row['close'] for row in sina}
    diffs = [abs(row['close'] - sina_map[row['date']]) for row in tencent if row['date'] in sina_map]
    return {
        'overlap_days': len(diffs),
        'max_abs_close_diff': max(diffs) if diffs else None,
        'mean_abs_close_diff': sum(diffs) / len(diffs) if diffs else None,
    }


def write_csv(path, rows, fields):
    with path.open('w', newline='', encoding='utf-8-sig') as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def style_sheet(ws, number_formats):
    header_fill = PatternFill('solid', fgColor='173B57')
    header_font = Font(color='FFFFFF', bold=True)
    for cell in ws[1]:
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal='center', vertical='center')
    ws.freeze_panes = 'A2'
    ws.auto_filter.ref = ws.dimensions
    for column, fmt in number_formats.items():
        for cell in ws.iter_cols(min_col=column, max_col=column, min_row=2):
            cell[0].number_format = fmt
    for index, column in enumerate(ws.columns, start=1):
        max_length = max(len(str(cell.value)) if cell.value is not None else 0 for cell in column)
        ws.column_dimensions[get_column_letter(index)].width = min(max(max_length + 3, 12), 24)


def write_workbook(path, merged, dividend, chinext, metadata):
    wb = Workbook()
    ws = wb.active
    ws.title = '合并计算'
    merged_headers = ['日期', '中证红利收盘', '创业板指收盘', 'R', '红利90月线', '红利40月线', '距90月线%', '距40月线%']
    ws.append(merged_headers)
    for row in merged:
        ws.append([date.fromisoformat(row['date']), row['zzhl_close'], row['cyb_close'], row['R'], row['zzhl_ma90'], row['zzhl_ma40'], row['zzhl_dist90_pct'], row['zzhl_dist40_pct']])
    style_sheet(ws, {1: 'yyyy-mm-dd', 2: '0.000', 3: '0.000', 4: '0.0000', 5: '0.000', 6: '0.000', 7: '0.00"%"', 8: '0.00"%"'})

    for name, rows in [('中证红利', dividend), ('创业板指', chinext)]:
        ws = wb.create_sheet(name)
        ws.append(['日期', '开盘', '最高', '最低', '收盘', '成交量', '涨跌幅%', '来源'])
        for row in rows:
            ws.append([date.fromisoformat(row['date']), row['open'], row['high'], row['low'], row['close'], row['volume'], row['change_pct'], row['source']])
        style_sheet(ws, {1: 'yyyy-mm-dd', 2: '0.000', 3: '0.000', 4: '0.000', 5: '0.000', 6: '#,##0', 7: '0.00"%"'})

    notes = wb.create_sheet('说明')
    notes.append(['项目', '说明'])
    notes.append(['生成时间', metadata['generated_at']])
    notes.append(['中证红利代码', '000922'])
    notes.append(['创业板指代码', '399006'])
    notes.append(['中证红利区间', f"{dividend[0]['date']} 至 {dividend[-1]['date']}，{len(dividend)} 个交易日"])
    notes.append(['创业板指区间', f"{chinext[0]['date']} 至 {chinext[-1]['date']}，{len(chinext)} 个交易日"])
    notes.append(['合并区间', f"{merged[0]['date']} 至 {merged[-1]['date']}，{len(merged)} 个交易日"])
    notes.append(['90/40月线算法', '以中证红利每日收盘作为当月暂定收盘，取最近90/40个月末收盘的简单平均。'])
    notes.append(['R算法', '创业板指当日收盘 ÷ 中证红利当日收盘。'])
    notes.append(['价格单位', '指数点；成交量为源数据原始单位。'])
    notes.append(['数据来源', '中证红利：新浪行情 2005 年至 2008-07-30，腾讯行情 2008-07-31 起；创业板指：腾讯行情，并与新浪行情交叉核对。'])
    notes.append(['核对结果', json.dumps(metadata['overlap'], ensure_ascii=False)])
    notes.append(['重要说明', '历史指数数据仅供研究与可视化，不构成投资建议。'])
    style_sheet(notes, {})

    wb.save(path)


def main():
    dividend_tencent = []
    for start, end in [
        ('2008-01-01', '2015-12-31'),
        ('2016-01-01', '2020-12-31'),
        ('2021-01-01', '2026-10-21'),
    ]:
        dividend_tencent.extend(fetch_tencent('sh000922', start, end))
    dividend_tencent = dedupe(dividend_tencent)
    dividend_sina = fetch_sina('sh000922')
    sina_last = max(row['date'] for row in dividend_sina)
    dividend = merge_preferred([row for row in dividend_sina if row['date'] <= sina_last], dividend_tencent)
    dividend_adjustments = sanitize_ohlc(dividend)
    change_pct(dividend)

    chinext_tencent, chinext_sina = build_chinext()
    chinext = merge_preferred(chinext_sina, chinext_tencent)
    chinext_adjustments = sanitize_ohlc(chinext)
    change_pct(chinext)
    merged = add_ma_rows(dividend, chinext)

    validate(dividend, '中证红利')
    validate(chinext, '创业板指')

    metadata = {
        'generated_at': time.strftime('%Y-%m-%d %H:%M:%S %z'),
        'dividend_count': len(dividend),
        'chinext_count': len(chinext),
        'merged_count': len(merged),
        'overlap': {
            'dividend': overlap_check(dividend_tencent, dividend_sina),
            'chinext': overlap_check(chinext_tencent, chinext_sina),
        },
        'ohlc_adjustments': {
            'dividend': dividend_adjustments,
            'chinext': chinext_adjustments,
        },
    }

    fields = ['date', 'open', 'high', 'low', 'close', 'volume', 'change_pct', 'source']
    write_csv(OUT / '000922_csi_dividend_daily.csv', dividend, fields)
    write_csv(OUT / '399006_chinext_daily.csv', chinext, fields)
    write_csv(OUT / 'combined_R_MA90_MA40_daily.csv', merged, [
        'date', 'zzhl_close', 'cyb_close', 'R', 'zzhl_ma90', 'zzhl_ma40', 'zzhl_dist90_pct', 'zzhl_dist40_pct'
    ])
    write_workbook(OUT / 'index_full_data.xlsx', merged, dividend, chinext, metadata)
    (OUT / 'data_manifest.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')

    print(json.dumps(metadata, ensure_ascii=False, indent=2))
    for path in sorted(OUT.iterdir()):
        print(f'{path.name}\t{path.stat().st_size}')


if __name__ == '__main__':
    main()
