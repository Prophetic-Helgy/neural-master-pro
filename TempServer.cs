using System;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using LibreHardwareMonitor.Hardware;

namespace NeuralMasterTempServer
{
    class Program
    {
        private static Computer? computer;
        private static HttpListener? listener;
        private static readonly CancellationTokenSource cts = new();
        private static double lastCpuTemp = 45;
        private static double lastGpuTemp = 50;

        static async Task Main(string[] args)
        {
            Console.WriteLine("🚀 Neural Master Pro Temperature Server (LibreHardwareMonitor) запущен");

            // Инициализация LibreHardwareMonitor
            computer = new Computer
            {
                IsCpuEnabled = true,
                IsGpuEnabled = true,
                IsMotherboardEnabled = false
            };
            computer.Open();

            // Запуск HTTP-сервера
            listener = new HttpListener();
            listener.Prefixes.Add("http://localhost:51234/");
            listener.Prefixes.Add("http://127.0.0.1:51234/");
            listener.Start();

            Console.WriteLine("✅ Сервер слушает http://localhost:51234/");

            // Фоновое обновление датчиков
            _ = Task.Run(() => UpdateSensorsLoop(cts.Token));

            // Обработка запросов
            while (!cts.Token.IsCancellationRequested)
            {
                try
                {
                    var context = await listener.GetContextAsync();
                    _ = Task.Run(() => HandleRequest(context));
                }
                catch (Exception) { break; }
            }

            listener?.Stop();
            computer?.Close();
            Console.WriteLine("🛑 Сервер остановлен");
        }

        private static void UpdateSensorsLoop(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    computer?.Accept(new UpdateVisitor());

                    foreach (var hardware in computer?.Hardware ?? Array.Empty<IHardware>())
                    {
                        if (hardware.HardwareType == HardwareType.Cpu)
                        {
                            foreach (var sensor in hardware.Sensors)
                            {
                                if (sensor.SensorType == SensorType.Temperature && 
                                    (sensor.Name.Contains("Package") || sensor.Name.Contains("Tctl") || sensor.Name.Contains("Tdie")))
                                {
                                    lastCpuTemp = sensor.Value ?? lastCpuTemp;
                                }
                            }
                        }
                        if (hardware.HardwareType == HardwareType.GpuNvidia || hardware.HardwareType == HardwareType.GpuAmd || hardware.HardwareType == HardwareType.GpuIntel)
                        {
                            foreach (var sensor in hardware.Sensors)
                            {
                                if (sensor.SensorType == SensorType.Temperature)
                                {
                                    lastGpuTemp = sensor.Value ?? lastGpuTemp;
                                }
                            }
                        }
                    }
                }
                catch { /* silent */ }

                Thread.Sleep(800);
            }
        }

        private static void HandleRequest(HttpListenerContext context)
        {
            try
            {
                // allow cors
                context.Response.Headers.Add("Access-Control-Allow-Origin", "*");
                
                var response = new
                {
                    cpu = Math.Round(lastCpuTemp, 1),
                    gpu = Math.Round(lastGpuTemp, 1),
                    overheat = lastCpuTemp > 82 || lastGpuTemp > 88,
                    timestamp = DateTime.UtcNow.ToString("o")
                };

                var json = JsonSerializer.Serialize(response);
                var buffer = Encoding.UTF8.GetBytes(json);

                context.Response.ContentType = "application/json";
                context.Response.ContentLength64 = buffer.Length;
                context.Response.OutputStream.Write(buffer, 0, buffer.Length);
                context.Response.Close();
            }
            catch { }
        }

        public class UpdateVisitor : IVisitor
        {
            public void VisitComputer(IComputer computer) => computer.Traverse(this);
            public void VisitHardware(IHardware hardware)
            {
                hardware.Update();
                foreach (var sub in hardware.SubHardware) sub.Accept(this);
            }
            public void VisitSensor(ISensor sensor) { }
            public void VisitParameter(IParameter parameter) { }
        }
    }
}
