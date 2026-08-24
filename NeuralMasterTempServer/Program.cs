using System;
using System.Net;
using System.Text;
using System.Threading.Tasks;
using System.Diagnostics;
using System.IO;
using System.Linq;
using OpenHardwareMonitor.Hardware;

namespace NeuralMasterTempServer
{
    class Program
    {
        static float _cpuTemp = 0;
        static float _gpuTemp = 0;

        static void Main(string[] args)
        {
            var listener = new HttpListener();
            listener.Prefixes.Add("http://127.0.0.1:51234/");
            listener.Start();

            Console.WriteLine("NeuralMasterTempServer running on http://127.0.0.1:51234/");

            _ = Task.Run(() => MonitorTemperatures());

            try
            {
                while (listener.IsListening)
                {
                    var ctxTask = listener.GetContextAsync();
                    if (!ctxTask.Wait(2000)) continue;

                    var ctx = ctxTask.Result;
                    var response = ctx.Response;

                    var json = $"{{\"cpu\":{Math.Round(_cpuTemp)},\"gpu\":{Math.Round(_gpuTemp)}}}";
                    var buffer = Encoding.UTF8.GetBytes(json);

                    response.ContentType = "application/json";
                    response.ContentLength64 = buffer.Length;
                    response.StatusCode = 200;

                    using (var output = response.OutputStream)
                    {
                        output.Write(buffer, 0, buffer.Length);
                    }
                }
            }
            finally
            {
                listener.Stop();
            }
        }

        static async Task MonitorTemperatures()
        {
            var computer = new Computer
            {
                CPUEnabled = true,
                GPUEnabled = true,
                RAMEnabled = true
            };

            computer.Open();

            try
            {
                while (true)
                {
                    try
                    {
                        _cpuTemp = 0;
                        _gpuTemp = 0;

                        // Traverse all hardware using OHM
                        foreach (IHardware hw in computer.Hardware)
                        {
                            hw.Update();
                            ProcessHardware(hw);
                        }

                        // Fallback: try NVIDIA via nvidia-smi if GPU temp still 0
                        if (_gpuTemp == 0)
                        {
                            int? nvidiaTemp = GetNvidiaSmiTemp();
                            if (nvidiaTemp.HasValue && nvidiaTemp.Value > 0)
                            {
                                _gpuTemp = nvidiaTemp.Value;
                            }
                        }

                        // Fallback: try WMI if CPU temp still 0
                        if (_cpuTemp == 0)
                        {
                            int? wmiTemp = GetWmiThermalTemp();
                            if (wmiTemp.HasValue && wmiTemp.Value > 20 && wmiTemp.Value < 100)
                            {
                                _cpuTemp = wmiTemp.Value;
                            }
                        }

                        Console.WriteLine($"CPU: {_cpuTemp:F1}°C, GPU: {_gpuTemp:F1}°C");
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"Temp error: {ex.Message}");
                    }

                    await Task.Delay(2000);
                }
            }
            finally
            {
                computer.Close();
            }
        }

        static void ProcessHardware(IHardware hw)
        {
            string hwTypeName = hw.HardwareType.ToString().ToLowerInvariant();

            foreach (var sensor in hw.Sensors)
            {
                if (sensor.SensorType != SensorType.Temperature || sensor.Value == null)
                    continue;

                float temp = (float)sensor.Value;
                string name = sensor.Name.ToLowerInvariant();

                // CPU temperature detection
                if (hwTypeName == "cpu")
                {
                    if (temp > 0 && temp < 100)
                    {
                        // Prefer "Core", "Package", "Tdie" sensors
                        if (name.Contains("core") || name.Contains("package") || name.Contains("tdie") || 
                            name.Contains("thermal") || name.Contains("thermal sensor"))
                        {
                            _cpuTemp = Math.Max(_cpuTemp, temp);
                        }
                        else if (name.Contains("cpu"))
                        {
                            _cpuTemp = Math.Max(_cpuTemp, temp);
                        }
                    }
                }

                // GPU temperature detection (Nvidia, AMD)
                if (hwTypeName.Contains("gpu") || hwTypeName.Contains("nvidia") || hwTypeName.Contains("amd"))
                {
                    if (temp > 0 && temp < 120 && name.Contains("core"))
                    {
                        _gpuTemp = Math.Max(_gpuTemp, temp);
                    }
                }
            }

            // Also check sub-hardware
            foreach (IHardware sub in hw.SubHardware)
            {
                sub.Update();
                ProcessHardware(sub);
            }
        }

        static int? GetNvidiaSmiTemp()
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "nvidia-smi",
                    Arguments = "--query-gpu=temperature.gpu --format=csv,noheader",
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };

                using (var proc = Process.Start(psi))
                {
                    if (proc != null)
                    {
                        proc.WaitForExit(3000);
                        var output = proc.StandardOutput.ReadToEnd().Trim();
                        if (int.TryParse(output, out int temp))
                            return temp;
                    }
                }
            }
            catch { }
            return null;
        }

        static int? GetWmiThermalTemp()
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -Command \"Get-CimInstance -Namespace root\\WMI -ClassName MSAcpi_ThermalZoneTemperature | ForEach-Object { [math]::Round(($_.CurrentTemperature / 1000) - 273.15) }\"",
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };

                using (var proc = Process.Start(psi))
                {
                    if (proc != null)
                    {
                        proc.WaitForExit(5000);
                        var output = proc.StandardOutput.ReadToEnd().Trim();
                        var lines = output.Split('\n', StringSplitOptions.RemoveEmptyEntries);
                        int maxTemp = 0;
                        foreach (var line in lines)
                        {
                            if (int.TryParse(line.Trim(), out int temp) && temp > maxTemp)
                                maxTemp = temp;
                        }
                        return maxTemp > 0 ? maxTemp : (int?)null;
                    }
                }
            }
            catch { }
            return null;
        }
    }
}