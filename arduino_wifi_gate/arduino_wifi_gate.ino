#include <Servo.h>

Servo gate;
Stream *comm; // pointer to selected Serial (Serial or Serial3)
const int potPin = A4; // R4 พอต 4 connected to analog A4
bool scanPassed = false;
unsigned long scanTimestamp = 0;
const unsigned long scanTimeout = 10000; // ms: window after a successful scan

void setup() {
  // สำคัญ: ต้องตรงกับ baudRate: 9600 ใน server.js
#if defined(UBRR3H)
  // บอร์ดที่มี Serial3 (ตัวอย่าง: Mega) จะใช้พอร์ตอนุกรมที่ 3
  Serial3.begin(9600);
  comm = &Serial3;
#else
  // บอร์ดอื่นๆ (เช่น Uno) ใช้ Serial ปกติ (USB)
  Serial.begin(9600);
  comm = &Serial;
#endif

  gate.attach(9);
  gate.write(0); // เริ่มต้นไม้กั้นปิดที่ 0 องศา
}

void loop() {
  // ถ้าระบบ Node.js ส่งคำสั่งพิมพ์อะไรบางอย่างลงมา
  if (comm->available()) {
    String command = comm->readStringUntil('\n');
    command.trim(); // ลบช่องว่างส่วนเกิน

    // รองรับคำสั่งหลายแบบจากเซิร์ฟเวอร์: open, open_in, open_out, in, out
    if (command == "open" || command == "open_in" || command == "open_out" || command == "in" || command == "out") {
      // อ่านค่า potentiometer (R4 พอต 3) เพื่อกำหนดมุมเปิด (0-90)
      int raw = analogRead(potPin);
      int angle = map(raw, 0, 1023, 0, 90);

      // หากค่ามุมที่ได้น้อยกว่า 30 องศา (เช่น หมุนไว้สุด หรือไม่ได้ต่อ Potentiometer)
      // ให้ใช้มุมเริ่มต้นที่ 90 องศา เพื่อป้องกันปัญหาไม้กั้นไม่ขยับ
      if (angle < 30) {
        angle = 90;
      }

      // เปิดไม้กั้น ตามมุมที่กำหนด
      gate.write(angle);
      delay(5000); // รอรถขับผ่าน 5 วินาที (ปรับเปลี่ยนความเร็วมุมเปิด-ปิดตามต้องการ)

      // ปิดไม้กั้นลง 0 องศา
      gate.write(0);

      // แจ้งกลับไปว่าเสร็จแล้ว
      comm->println("done");
    }
    // รับคำสั่งกำหนดมุมโดยตรง เช่น "open:90" — จะทำงานทันทีไม่ต้องการการสแกน
    else if (command.startsWith("open:")) {
      String val = command.substring(command.indexOf(':') + 1);
      val.trim();
      int angle = val.toInt();
      if (angle < 0) angle = 0;
      if (angle > 180) angle = 180; // safety cap

      gate.write(angle);
      delay(5000);
      gate.write(0);
      comm->println("done");
    }
    // ถ้ารับข้อความยืนยันการสแกนผ่าน ให้บันทึกสถานะ
    else if (command == "scan_ok" || command == "scan_passed" || command == "scan:ok") {
      scanPassed = true;
      scanTimestamp = millis();
      comm->println("scan_received");
    }
  }
}
