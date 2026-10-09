"""Each site's plan names, matched to the registry plan they are. A name left out
is a plan the registry does not carry (a dearer discount tier, a standard rate,
prepay, dynamic, or existing customers only) and is not scored."""
E28, E23, E26 = 'EN-SMART-24-HOUR@28', 'EN-SMART@23', 'EN-24@26'
BK = {'Bord Gáis Energy|Smart All Day Electricity 28%': 'BG-24', 'Bord Gáis Energy|Smart EV Plus Electricity': 'BG-EV',
 'Bord Gáis Energy|Standard Smart All Day Electricity': 'BG-STANDARD-VARIABLE-SMART-ALL-DAY-ELECTRICITY',
 'Bord Gáis Energy|Standard Smart Electricity 28%': 'BG-TOU', 'Bord Gáis Energy|Weekend Smart Electricity 28%': 'BG-WKND',
 'Bord Gáis Energy|Standard Plus Smart Electricity 28%': 'BG-TOU-PLUS',
 'Community Power|Standard Smart Electricity (SST)': 'CP-SST', 'Ecopower|Smart 24hr Electricity 10%': 'EP-24',
 'Ecopower|Standard Smart Electricity 10%': 'EP-SST', 'Electric Ireland|Home Electric SST 16%': 'EI-SST',
 'Electric Ireland|Home Electric+ Night Boost': 'EI-NB', 'Electric Ireland|Home Electric+ Saver 16%': 'EI-24',
 'Electric Ireland|Home Electric+ Weekender': 'EI-WKND', 'Energia|Smart 24 Hour': E28, 'Energia|Smart Data': E23,
 'Energia|Smart Day Night': 'EN-SMART-DAY-NIGHT', 'Energia|Smart Drive 10%': 'EN-EV',
 'Flogas|Smart 24Hr Electricity 29%': 'FL-24', 'Flogas|Smart EV Night Charge 29%': 'FL-EV',
 'Flogas|Smart Electricity 29% Loyalty Discount': 'FL-DNP', 'Pinergy|Pinergy Lifestyle SST': 'PIN-LF',
 'Pinergy|Pinergy Lifestyle Family Time': 'PIN-FAM', 'Pinergy|Pinergy Lifestyle Working from Home Time': 'PIN-WFH',
 'SSE Airtricity|30% Day/Night/Peak Electricity': 'SSE-DNP', 'SSE Airtricity|Smart EV Max 20%': 'SSE-EVMAX',
 'SSE Airtricity|Smart Everyday 30%': 'SSE-EVDAY', 'SSE Airtricity|Smart Weekend': 'SSE-WKND',
 'Waterpower|Standard Smart Electricity (SST)': 'WP-SST', 'Yuno Energy|1 Year Smart Day/Night/Peak Electricity with Bonus': 'YN-DNP',
 'Yuno Energy|1 Year Smart Discount Electricity with Bonus': 'YN-24', 'Yuno Energy|Smart EV Variable 24hr': 'YN-EV',
 'Yuno Energy|Smart EV Variable': 'YN-EV-DNP', 'PrepayPower|Smart Pay Day Night Peak': 'PPP-TOU',
 # 24-hour meter
 'Waterpower|Standard Electricity (eBill)': 'WP-24', 'SSE Airtricity|30% Electricity': 'SSE-24', 'Energia|Home Electricity': E26,
 'Flogas|Electricity 28% Loyalty Discount': 'FL-STD-24', 'Community Power|Standard Variable Electricity': 'CP-24'}
DD = ' • Direct Debit & Online Billing'
KW = {'Electric Ireland|Home Electric+ SST Discount': 'EI-SST', 'Electric Ireland|Home Electric+ Saver Discount': 'EI-24',
 'Electric Ireland|Home Electric+ Night Boost Discount': 'EI-NB', 'Electric Ireland|Home Electric+ Weekender Saturday Discount': 'EI-WKND', 'Electric Ireland|Home Electric+ Weekender Sunday Discount': 'EI-WKND@sun',
 'Bord Gáis Energy|New Customer Smart All Day Electricity Discount': 'BG-24', 'Bord Gáis Energy|New Customer Smart Standard Electricity Discount': 'BG-TOU',
 'Bord Gáis Energy|New Customer Smart Standard Plus Electricity Discount': 'BG-TOU-PLUS', 'Bord Gáis Energy|New Customer Smart Weekend Electricity Discount': 'BG-WKND',
 'Bord Gáis Energy|New Customer Smart EV Plus Electricity Discount': 'BG-EV',
 'Bord Gáis Energy|Standard Variable Smart All Day Electricity': 'BG-STANDARD-VARIABLE-SMART-ALL-DAY-ELECTRICITY',
 'Community Power|Smart SST': 'CP-SST', 'Ecopower Supply|24 Hour Smart Meter – Domestic': 'EP-24', 'Ecopower Supply|Smart Meter - Domestic Discount': 'EP-SST',
 'Energia|Smart 24 Hour Discount' + DD: E28, 'Energia|Smart Data and Discount' + DD: E23,
 'Energia|Smart Day Night Discount' + DD: 'EN-SMART-DAY-NIGHT', 'Energia|EV Smart Drive' + DD: 'EN-EV',
 'Flogas|Smart 24Hr Electricity Loyalty Discount': 'FL-24',  # kilowatt.ie's other Flogas plans are the 10% versions, not the 29% loyalty offer
 'Pinergy|Pinergy Lifestyle Family Time': 'PIN-FAM', 'Pinergy|Pinergy Lifestyle Standard Smart Tariff': 'PIN-LF', 'Pinergy|Pinergy Lifestyle Working from Home Time': 'PIN-WFH',
 'PrepayPower|Smart Pay Day Night Peak Smart': 'PPP-TOU',
 'SSE Airtricity|Smart Everyday Top Discount - Smart' + DD: 'SSE-EVDAY', 'SSE Airtricity|Smart Weekends - Smart' + DD: 'SSE-WKND',
 'SSE Airtricity|Smart EV Max - Smart' + DD: 'SSE-EVMAX', 'WaterPower|Waterpower Smart Tariff (SST)': 'WP-SST',
 'Yuno Energy|Variable Smart Discount': 'YN-DNP', 'Yuno Energy|Variable Discount Plan 24h': 'YN-24', 'Yuno Energy|EV Variable': 'YN-EV', 'Yuno Energy|EV Variable Smart': 'YN-EV-DNP',
 # 24-hour meter
 'Electric Ireland|EnergySaver 24h Discount': 'EI-ES', 'SSE Airtricity|Electricity Top Discount - 24h' + DD: 'SSE-24', 'Energia|Electricity 24 hour Discount' + DD: E26,
 'WaterPower|Domestic 24 Hour Online Billing': 'WP-24', 'Electric Ireland|Green Electricity 24h Discount': 'EI-GREEN', 'Community Power|Standard Variable Rate 24h': 'CP-24'}
# Plans a household switching supplier cannot take: kilowatt.ie lists them among the rest.
KW_NOT_OPEN = ('Existing Customer', 'Smart-NHH', 'prepay', 'Pay As You Go', 'PAYG', 'Prepaid', 'Classic Pay', 'Smart Pay', 'Winter/Summer')
SW = {'Home Electric+ 24 Hour Saver 16%': 'EI-24', 'Home Electric+ SST Saver 16%': 'EI-SST', 'Home Electric SST Saver 16%': 'EI-SST',
 'Home Electric+ Night Boost 5.5%': 'EI-NB', 'Home Electric+ Weekender 5.5% (Free Saturday)': 'EI-WKND', 'Home Electric+ Weekender 5.5% (Free Sunday)': 'EI-WKND@sun',
 'Smart Data 23%': E23, 'Smart 24 Hour 28%': E28, 'Smart Data 27%': 'EN-SMART', 'Smart 24 Hour 30%': 'EN-SMART-24-HOUR', 'EV Smart Drive 10%': 'EN-EV',
 'Waterpower Smart Tariff (SST)': 'WP-SST', '1 Year Smart Day/Night/Peak 30% DD & eBill': 'SSE-DNP', '1 Year Smart Everyday 30% DD & eBill': 'SSE-EVDAY',
 '1 Year Smart EV Max Electricity 20% DD & eBill': 'SSE-EVMAX', '1 Year Smart Weekends Electricity 15% DD & eBill': 'SSE-WKND',
 'Smart Electricity 29% Loyalty Discount': 'FL-DNP', 'Smart 24Hr Electricity 29% Loyalty Discount': 'FL-24', 'Smart EV Night Charge 29% Electricity Loyalty Discount': 'FL-EV',
 'Smart All Day Electricity 28% Discount': 'BG-24', 'Standard Smart New Elec Only 28% Discount': 'BG-TOU',
 'Smart Standard Plus Electricity 28% Discount (New Customers)': 'BG-TOU-PLUS', 'Smart EV Plus Electricity 15% Discount': 'BG-EV',
 'Smart Weekend New Elec Only 28% Discount': 'BG-WKND', 'Standard Variable Smart All Day Electricity 0% Discount': 'BG-STANDARD-VARIABLE-SMART-ALL-DAY-ELECTRICITY',
 '1 Year Smart Day/Night/Peak Electricity with Welcome Bonus': 'YN-DNP', '1 Year Electricity Variable Plan Smart with Welcome Bonus': 'YN-24',
 'EV Variable Discount Smart Electricity Plan Day/Night/Peak': 'YN-EV-DNP', 'EV Variable Discount Smart Electricity Plan 24hr': 'YN-EV',
 'Smart SST': 'CP-SST', 'Smart 10% Discount': 'EP-SST', 'Smart 24 Hour 10% Discount': 'EP-24', 'Smart Pay Time of Use Tariff': 'PPP-TOU',
 # 24-hour meter (the first 'Standard Electricity' is Waterpower's e-billing plan, the first 'Standard' Community Power's)
 '1 Year Home Electricity 30% DD & eBill': 'SSE-24', 'Standard Electricity 26%': E26, 'Standard Electricity': 'WP-24', 'Standard': 'CP-24', 'Classic Pay': 'PPP-24'}
SW_NOT_OPEN = ('Prepay', 'Classic Pay', 'Smart Pay', 'Pinergy Smart')
EP = {'Flo Gas|Smart 24Hr Electricity 29% Loyalty Discount': 'FL-24', 'Flo Gas|Smart Electricity 29% Loyalty Discount': 'FL-DNP',
 'Flo Gas|Smart EV Night Charge 29% Electricity Discount': 'FL-EV', 'Waterpower|Waterpower Smart Tariff (SST)': 'WP-SST',
 'Electric Ireland|Home Electric+ SST Saver 16%': 'EI-SST', 'Electric Ireland|Home Electric+ Saver 16%': 'EI-24',
 'Electric Ireland|Home Electric+ Night Boost': 'EI-NB', 'Electric Ireland|Home Electric+ Weekender (Saturday)': 'EI-WKND', 'Electric Ireland|Home Electric+ Weekender (Sunday)': 'EI-WKND@sun',
 'Energia|Smart 24 Hour (From 12th Oct)': E28, 'Energia|Smart Data (From 12th Oct)': E23, 'Energia|EV Smart Drive (From 12th Oct)': 'EN-EV',
 'Energia|Smart Day Night (From 12th Oct)': 'EN-SMART-DAY-NIGHT',
 'SSE Airtricity|Smart Day / Night / Peak - Top discount': 'SSE-DNP', 'SSE Airtricity|Smart Everyday - Top discount': 'SSE-EVDAY',
 'SSE Airtricity|Smart Weekends': 'SSE-WKND', 'SSE Airtricity|Smart EV Max': 'SSE-EVMAX',
 'Bord Gais|Smart All Day Electricity Discount (From 9th Oct)': 'BG-24', 'Bord Gais|Smart Weekend Electricity Discount (From 9th Oct)': 'BG-WKND',
 'Bord Gais|Smart Standard Electricity Discount (From 9th Oct)': 'BG-TOU', 'Bord Gais|Smart EV Plus Electricity Discount (From 9th Oct)': 'BG-EV',
 'Bord Gais|Smart Standard Plus Electricity Discount (From 9th Oct)': 'BG-TOU-PLUS',
 'Yuno|Electricity Bonus 24h': 'YN-24', 'Yuno|Electricity Smart Bonus': 'YN-DNP', 'Yuno|EV Variable': 'YN-EV', 'Yuno|EV Variable Smart': 'YN-EV-DNP',
 'Eco Power|24 Hour Smart Meter – Domestic': 'EP-24', 'Eco Power|SST Smart Meter – Domestic': 'EP-SST',
 'Community Power|Smart SST_DG1_CP_23': 'CP-SST', 'Pinergy|Standard Smart Tariff': 'PIN-LF'}
# EnergyPal lists plans this meter cannot take (day/night and 24-hour meter plans) beside the smart ones.
EP_NOT_OPEN = ('Day/Night', 'Standard 24 Hr', 'Dynamic', 'Smart Track')
