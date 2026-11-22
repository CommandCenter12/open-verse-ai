---
title: Mechatronics Fundamentals
domain: engineering
---
# Mechatronics Fundamentals

## Ohm's law and electrical power
Ohm's law states V = I × R, where V is voltage in volts, I is current in amperes and R is resistance in ohms. Electrical power is P = V × I, which can also be written P = I² × R or P = V² / R. For example, a 12 V motor drawing 2 A consumes 24 W.

## PWM (pulse width modulation)
PWM controls average power by switching a signal fully on and off at a fixed frequency. The duty cycle is the fraction of each period the signal is on. The average voltage equals duty cycle × supply voltage, so a 25% duty cycle on a 12 V supply averages 3 V. Motor drivers commonly use PWM frequencies above 20 kHz to stay above human hearing.

## H-bridge motor driver
An H-bridge uses four switches to apply voltage across a DC motor in either direction, which allows forward, reverse, braking and coasting. Never turn on both switches on the same side at once, because that shorts the supply; this fault is called shoot-through. Driver chips add dead time between switching to prevent it.

## DC motor torque and speed
In a brushed DC motor, torque is proportional to current: T = Kt × I, where Kt is the torque constant. The back EMF is proportional to speed: E = Ke × ω. In SI units Kt and Ke are numerically equal. Speed falls roughly linearly as load torque rises, from no-load speed at zero torque to zero speed at stall torque. Mechanical power is P = T × ω, with ω in radians per second.

## Gear ratio
A gear ratio is the number of teeth on the driven gear divided by the number of teeth on the driving gear. A gear ratio of N multiplies output torque by N and divides output speed by N, ignoring losses. Real gearboxes lose energy, so output torque equals input torque × ratio × efficiency.

## Stepper motor
A stepper motor moves in fixed angular steps. A common 1.8 degree stepper has 200 full steps per revolution. Microstepping divides each full step electrically, so 16× microstepping gives 3200 microsteps per revolution. Steppers lose position silently if the load exceeds their torque, which is called missed steps, so closed-loop designs add an encoder.

## Encoders
An incremental quadrature encoder outputs two square waves, A and B, offset by 90 degrees, and the order of their edges gives direction. Counting every edge of both channels, called 4× decoding, gives counts per revolution equal to 4 × the encoder's lines per revolution. An absolute encoder reports the actual position directly, even after power loss.

## PID control
A PID controller computes output u = Kp × e + Ki × ∫e dt + Kd × de/dt, where e is the error between setpoint and measurement. The proportional term reacts to present error, the integral term removes steady-state error, and the derivative term damps overshoot by reacting to the rate of change. Integral windup happens when the actuator saturates while the integral keeps growing; clamp the integral or stop integrating while saturated.

## Tuning a PID controller
A simple manual tuning method: set Ki and Kd to zero, raise Kp until the response oscillates, then reduce Kp to about half. Add Ki slowly to remove steady-state error, then add Kd to reduce overshoot. Filter the derivative term because it amplifies sensor noise. The Ziegler–Nichols method uses the ultimate gain Ku and oscillation period Tu: Kp = 0.6 Ku, Ki = 1.2 Ku / Tu and Kd = 0.075 Ku × Tu.

## ADC resolution and sampling
An analog-to-digital converter with n bits divides its reference voltage into 2^n levels. The voltage resolution is Vref / 2^n, so a 12-bit ADC with a 3.3 V reference resolves about 0.8 mV. The Nyquist criterion requires sampling at more than twice the highest frequency in the signal, otherwise aliasing occurs. Add an analog low-pass anti-aliasing filter before the ADC.

## Sensors in mechatronic systems
Common sensors include potentiometers for angle, encoders for position and speed, strain gauges and load cells for force, thermistors and thermocouples for temperature, and IMUs, which combine an accelerometer and gyroscope, for orientation. Gyroscopes drift over time and accelerometers are noisy, so a complementary filter or Kalman filter fuses them.
