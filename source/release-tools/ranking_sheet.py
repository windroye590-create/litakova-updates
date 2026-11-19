"""Reproducible formulas for the linked ranking sheet (Google Sheets locale en_US).

The service key is the original test ID across explicit replacement versions.
Titles are a temporary fallback until the owner-side identity migration finishes.
Raw result rows remain an audit history; only the latest attempt contributes.
"""
import json


def summary_formula():
    tab="'Результати курсантів'"
    key_column=f'MATCH("_Ключ тесту",{tab}!1:1,0)'
    keys=f'IFERROR(INDIRECT("{tab}!"&ADDRESS(2,{key_column},4)&":"&ADDRESS(ROWS({tab}!A:A),{key_column},4)),{tab}!C2:C)'
    return (f'=IFNA(LET(keys,{keys},source,FILTER({{TO_TEXT({tab}!N2:N),{tab}!B2:B,'
            f'IF(keys<>"",TO_TEXT(keys),{tab}!C2:C),{tab}!D2:D,{tab}!J2:J,{tab}!A2:A,'
            f'IFERROR(VALUE({tab}!O2:O),TO_TEXT({tab}!O2:O))}},'
            f'{tab}!O2:O<>"",ISNUMBER({tab}!D2:D),ISNUMBER({tab}!J2:J),({tab}!J2:J+{tab}!K2:K)>0),'
            'latest,SORTN(SORT(source,4,FALSE,7,FALSE),9^9,2,1,TRUE,2,TRUE,3,TRUE),'
            'QUERY(latest,"select Col1,Col2,sum(Col5) group by Col1,Col2 order by sum(Col5) desc '
            'label Col1 \'\',Col2 \'\',sum(Col5) \'\'",0)),"")')


def ranking_formulas(last_row=1004):
    users=f'G5:G{last_row}'
    totals=f'I5:I{last_row}'
    return [
        f'=ARRAYFORMULA(IF({users}="","",RANK({totals},{totals},0)))',
        f'=ARRAYFORMULA(IF({users}="","",IFNA(VLOOKUP(TO_TEXT({users}),'
        '{TO_TEXT(\'Результати курсантів\'!N2:N),\'Результати курсантів\'!A2:A},2,FALSE),"")))',
        f'=ARRAYFORMULA(IF({users}="","",{totals}))',
        f'=ARRAYFORMULA(IF({users}="","",H5:H{last_row}))',
    ]


if __name__ == '__main__':
    print(json.dumps({'summary':summary_formula(),'ranking':ranking_formulas()},ensure_ascii=False))
